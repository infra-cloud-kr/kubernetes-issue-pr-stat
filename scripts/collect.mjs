#!/usr/bin/env node
/**
 * kubernetes/website 의 language/ko Issue/PR 을 수집해서
 * 한글화팀이 "확인이 필요한" 항목으로 분류한 report.json 을 생성한다.
 *
 * 의존성 없음 (Node 20+ 내장 fetch 사용)
 *
 * 실행:
 *   GITHUB_TOKEN=ghp_xxx node scripts/collect.mjs
 */

import { writeFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// 설정 (환경변수로 오버라이드 가능)
// ---------------------------------------------------------------------------
const CONFIG = {
  repo: process.env.TARGET_REPO ?? "kubernetes/website",
  label: process.env.TARGET_LABEL ?? "language/ko",
  /** 연결된 PR이 이 기간 동안 갱신되지 않으면 "정체"로 본다 */
  staleDays: num(process.env.STALE_DAYS, 30),
  /** PR이 이 기간 이상 열려 있으면 "장기 미병합"으로 본다 */
  longOpenDays: num(process.env.LONG_OPEN_DAYS, 60),
  /** 이슈가 이 기간 이상 PR 없이 방치되면 "담당자 필요"로 본다 */
  noPrDays: num(process.env.NO_PR_DAYS, 30),
  out: process.env.OUT ?? "docs/data/report.json",
  /** 스냅샷 원본을 보관할 디렉터리 (주차별 파일) */
  snapshotDir: process.env.SNAPSHOT_DIR ?? "docs/data/snapshots",
  /** 집계만 담는 추이 파일 (영구 보관) */
  trendOut: process.env.TREND_OUT ?? "docs/data/trend.json",
  /** 원본 스냅샷을 몇 주까지 롤링 보관할지 (집계는 무관하게 영구) */
  keepWeeks: num(process.env.KEEP_WEEKS, 8),
  token: process.env.GITHUB_TOKEN,
};

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

if (!CONFIG.token) {
  console.error(
    "GITHUB_TOKEN 이 필요합니다. public repo 조회만 하므로 scope 없는 fine-grained token 이면 충분합니다."
  );
  process.exit(1);
}

const API = "https://api.github.com/graphql";
const DAY_MS = 86_400_000;
const NOW = Date.now();

// ---------------------------------------------------------------------------
// GraphQL 클라이언트 (429/5xx 지수 백오프 재시도)
// ---------------------------------------------------------------------------
async function gql(query, variables, attempt = 0) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.token}`,
      "Content-Type": "application/json",
      "User-Agent": "k8s-ko-triage",
    },
    body: JSON.stringify({ query, variables }),
  });

  if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 5) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 2 ** attempt * 1000;
    console.warn(`  ↻ HTTP ${res.status} — ${waitMs}ms 후 재시도 (${attempt + 1}/5)`);
    await sleep(waitMs);
    return gql(query, variables, attempt + 1);
  }

  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

  const body = await res.json();
  if (body.errors?.length) {
    throw new Error("GraphQL error: " + JSON.stringify(body.errors, null, 2));
  }
  return body.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** search 커넥션을 끝까지 순회한다. GraphQL search 는 최대 1000건까지만 페이징된다. */
async function searchAll(query, searchQuery) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = await gql(query, { q: searchQuery, after });
    nodes.push(...data.search.nodes.filter(Boolean));
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// 쿼리
// ---------------------------------------------------------------------------
const PR_FIELDS = `
  number title url state isDraft createdAt updatedAt mergedAt
  author { login }
  labels(first: 30) { nodes { name } }
`;

const ISSUE_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 25, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number title url state createdAt updatedAt
        author { login }
        assignees(first: 5) { nodes { login } }
        labels(first: 30) { nodes { name } }
        comments { totalCount }
        # GitHub Development 패널과 동일한 "이 이슈를 닫는 PR" 링크
        closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
          nodes { ${PR_FIELDS} }
        }
        # 링크가 안 걸린 채 본문에서만 언급된 PR 보완용
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 30) {
          nodes {
            ... on CrossReferencedEvent {
              willCloseTarget
              source { ... on PullRequest { ${PR_FIELDS} } }
            }
          }
        }
      }
    }
  }
}`;

/**
 * PR 트리아지 전용 추가 필드.
 * PR_FIELDS 와 분리한 이유: 이슈에 연결된 PR(이슈당 최대 20건)까지 이 필드를 끌면
 * GraphQL 노드 비용이 이슈 수 × 20 배로 불어난다. 최상위 PR 검색에만 붙인다.
 */
const PR_TRIAGE_FIELDS = `
  additions deletions changedFiles
  reviewDecision
  # last:1 이면 k8s-ci-robot 코멘트 하나에 사람의 마지막 발언이 가려진다.
  comments(last: 10) { totalCount nodes { author { login } createdAt } }
  reviews(last: 5) { totalCount nodes { author { login } state submittedAt } }
  # 롤업 state 는 쓰지 않는다 — Prow 의 tide 컨텍스트가 머지 전까지 PENDING 이라
  # 열린 PR 의 롤업은 사실상 항상 PENDING/FAILURE 로 뭉개진다. 개별 컨텍스트를 본다.
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(last: 100) {
            nodes {
              ... on CheckRun { name conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
  closingIssuesReferences(first: 10) {
    nodes { number url title state }
  }
`;

const PULL_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 25, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        ${PR_FIELDS}
        ${PR_TRIAGE_FIELDS}
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// 정규화 헬퍼
// ---------------------------------------------------------------------------
const daysSince = (iso) => Math.floor((NOW - new Date(iso).getTime()) / DAY_MS);
const labelNames = (n) => (n.labels?.nodes ?? []).map((l) => l.name);

/** Prow 워크플로 상태를 한눈에 보기 위한 플래그 */
function prowFlags(labels) {
  return {
    lgtm: labels.includes("lgtm"),
    approved: labels.includes("approved"),
    hold: labels.some((l) => l.startsWith("do-not-merge")),
    needsRebase: labels.includes("needs-rebase"),
    cncfUnsigned: labels.includes("cncf-cla: no"),
  };
}

/**
 * 개별 CI 컨텍스트에서 "실제로 실패한 검사"만 추린다.
 *
 * statusCheckRollup.state 를 그대로 쓰면 안 된다. Prow 는 머지 큐 상태를 `tide`
 * 컨텍스트로 노출하는데 이게 머지 직전까지 PENDING 이라, 열린 PR 의 롤업은
 * SUCCESS 가 될 수 없다. 실측에서도 53건 중 SUCCESS 는 0건이었다.
 * 그래서 컨텍스트를 개별로 보고, 정보성 컨텍스트는 제외한 뒤 실패만 센다.
 */
/**
 * 머지를 실제로 막는 검사만 센다.
 *
 * kubernetes/website 의 열린 PR 이 실제로 노출하는 컨텍스트는 6종뿐이다.
 *   tide            머지 큐 상태 — 머지 직전까지 PENDING 이라 신호가 아니다
 *   deploy/netlify  사이트 빌드 — 깨지면 문서가 렌더링되지 않으므로 차단
 *   EasyCLA         CLA 서명 — 미서명이면 머지 불가 (라벨로도 잡히지만 이중 확인)
 *   Pages changed / Header rules / Redirect rules
 *                   Netlify 빌드 플러그인 부산물 — 실패해도 머지를 막지 않는다
 *
 * 초기 구현은 rollup.state 를 그대로 썼는데, tide 때문에 SUCCESS 가 한 번도
 * 나오지 않았다(실측 53건 중 0건). 그다음엔 Prow 관례인 `pull-` 접두사로
 * 좁혔는데 이 저장소엔 presubmit 이 없어 0건이 매치됐다. 그래서 차단 검사를
 * 명시 목록으로 못박되, presubmit 이 생기거나 다른 k8s 저장소에 재사용할 때를
 * 위해 `pull-` 접두사도 함께 인정한다.
 */
const BLOCKING_CHECKS = new Set(["deploy/netlify", "EasyCLA"]);
const isBlockingCheck = (name) => BLOCKING_CHECKS.has(name) || name.startsWith("pull-");

function ciStatus(pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup) return { state: "none", failed: [] };

  const failed = [];
  let pending = 0;
  let passed = 0;
  for (const c of rollup.contexts?.nodes ?? []) {
    if (!c) continue;
    // CheckRun 은 conclusion, StatusContext 는 state 로 결과를 노출한다.
    const name = c.name ?? c.context;
    const result = c.conclusion ?? c.state;
    if (!name || !isBlockingCheck(name)) continue;
    if (result === "FAILURE" || result === "ERROR" || result === "TIMED_OUT") {
      failed.push({ name, url: c.detailsUrl ?? c.targetUrl ?? null });
    } else if (result === "SUCCESS" || result === "NEUTRAL" || result === "SKIPPED") {
      passed++;
    } else {
      pending++;
    }
  }
  // rollup.state 를 그대로 쓰지 않는 이유: tide 컨텍스트가 머지 직전까지
  // PENDING 이라 열린 PR 의 롤업은 SUCCESS 가 될 수 없다(실측 53건 중 0건).
  const state = failed.length ? "failed" : pending ? "pending" : passed ? "passed" : "none";
  return { state, failed };
}

/** 사람의 액션만 "공을 던진 것"으로 센다. 봇 코멘트는 대기 상태를 바꾸지 않는다. */
const BOT_LOGINS = new Set([
  "k8s-ci-robot",
  "k8s-triage-robot",
  "github-actions",
  "netlify",
  "dependabot",
  "linux-foundation-easycla",
  "ghost",
]);
const isBot = (login) => !login || BOT_LOGINS.has(login) || login.endsWith("[bot]");

/**
 * 마지막으로 "공을 던진" 사람이 누구인지 판정한다.
 * 작성자가 마지막이면 공은 우리(리뷰어) 코트에, 리뷰어가 마지막이면 작성자 코트에 있다.
 * touched 는 "작성자 아닌 사람이 한 번이라도 붙었는가" — 첫 리뷰 대기와
 * 재확인 대기를 가르는 신호라 별도로 돌려준다.
 */
function lastMoveBy(pr, author) {
  const events = [];
  for (const c of pr.comments?.nodes ?? []) {
    if (c?.author?.login && !isBot(c.author.login)) {
      events.push({ at: c.createdAt, login: c.author.login });
    }
  }
  for (const r of pr.reviews?.nodes ?? []) {
    if (r?.author?.login && !isBot(r.author.login)) {
      events.push({ at: r.submittedAt, login: r.author.login });
    }
  }
  const touched = events.some((e) => e.login !== author);
  if (!events.length) return { by: null, touched: false };
  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { by: events[0].login === author ? "author" : "reviewer", touched };
}

function normalizePr(pr) {
  const labels = labelNames(pr);
  const closingIssues = (pr.closingIssuesReferences?.nodes ?? []).map((i) => ({
    number: i.number,
    url: i.url,
    title: i.title,
    state: i.state,
  }));
  const author = pr.author?.login ?? "ghost";
  const ci = ciStatus(pr);
  const langLabels = labels.filter((l) => l.startsWith("language/"));
  return {
    ...(closingIssues.length ? { closingIssues } : {}),
    number: pr.number,
    title: pr.title,
    url: pr.url,
    // GraphQL PullRequestState: OPEN | CLOSED | MERGED
    state: pr.mergedAt ? "MERGED" : pr.state,
    isDraft: pr.isDraft ?? false,
    author,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt ?? null,
    ageDays: daysSince(pr.createdAt),
    idleDays: daysSince(pr.updatedAt),
    reviewDecision: pr.reviewDecision ?? null,
    labels,
    flags: prowFlags(labels),
    ...(pr.changedFiles == null
      ? {}
      : {
          ci,
          changedFiles: pr.changedFiles,
          additions: pr.additions ?? 0,
          deletions: pr.deletions ?? 0,
          comments: pr.comments?.totalCount ?? 0,
          reviews: pr.reviews?.totalCount ?? 0,
          ...lastMoveBy(pr, author),
          // language/ko 하나만 붙은 PR = 순수 한국어 번역.
          // 여러 언어가 붙었으면 원문 변경이 전 로케일에 파급된 PR이라 성격이 다르다.
          koOnly: langLabels.length === 1 && langLabels[0] === "language/ko",
        }),
  };
}

function normalizeIssue(issue) {
  // 두 경로에서 얻은 PR 을 number 기준으로 dedupe
  const byNumber = new Map();
  for (const pr of issue.closedByPullRequestsReferences?.nodes ?? []) {
    if (pr) byNumber.set(pr.number, pr);
  }
  for (const ev of issue.timelineItems?.nodes ?? []) {
    const pr = ev?.source;
    if (pr?.number != null && !byNumber.has(pr.number)) byNumber.set(pr.number, pr);
  }

  const linkedPrs = [...byNumber.values()]
    .map(normalizePr)
    .sort((a, b) => b.number - a.number);

  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    author: issue.author?.login ?? "ghost",
    assignees: (issue.assignees?.nodes ?? []).map((a) => a.login),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ageDays: daysSince(issue.createdAt),
    idleDays: daysSince(issue.updatedAt),
    comments: issue.comments?.totalCount ?? 0,
    labels: labelNames(issue),
    linkedPrs,
  };
}


// ---------------------------------------------------------------------------
// 워크리스트: "누가 막고 있나" 판정 (blocked-on 룰 엔진)
//
// 기존 분류는 "얼마나 오래됐나"를 물었다. 당번이 실제로 필요한 답은
// "지금 내가 손댈 게 무엇인가"이므로, 열린 PR 전체를 대기 주체별로 가른다.
// ours=true 인 두 레인(리뷰 차례 / 승인 대기)만 보면 당번 업무가 끝난다.
// ---------------------------------------------------------------------------
const LANES = [
  {
    id: "review",
    title: "리뷰 차례",
    ours: true,
    hint: "차단 요소가 없고 lgtm 도 없습니다. 우리가 볼 차례입니다.",
  },
  {
    id: "approve",
    title: "승인 대기",
    ours: true,
    hint: "lgtm 은 붙었지만 approved 가 없습니다. 어프루버에게 넘기세요.",
  },
  {
    id: "author",
    title: "작성자 대기",
    ours: false,
    hint: "공이 작성자 코트에 있습니다. 오래됐다면 핑만 보내면 됩니다.",
  },
  {
    id: "merge",
    title: "머지 대기",
    ours: false,
    hint: "lgtm + approved. tide 가 머지합니다. 할 일이 없습니다.",
  },
  {
    id: "blocked",
    title: "보류 · 초안",
    ours: false,
    hint: "hold 또는 draft 로 의도적으로 멈춰 있습니다. 건드리지 마세요.",
  },
];

/** Prow size 라벨 → 리뷰 소요 시간 추정(분). 라벨이 없으면 변경 라인으로 근사한다. */
const SIZE_MINUTES = {
  "size/XS": 3,
  "size/S": 5,
  "size/M": 15,
  "size/L": 30,
  "size/XL": 60,
  "size/XXL": 90,
};

function reviewCost(pr) {
  const label = pr.labels.find((l) => l in SIZE_MINUTES);
  let minutes = label ? SIZE_MINUTES[label] : null;
  if (minutes == null) {
    const lines = (pr.additions ?? 0) + (pr.deletions ?? 0);
    minutes = lines <= 10 ? 3 : lines <= 30 ? 5 : lines <= 100 ? 15 : lines <= 500 ? 30 : 60;
  }
  return {
    size: label ? label.slice("size/".length) : "?",
    minutes,
    // 짧은 것부터 처리하면 큐가 눈에 띄게 줄어든다. 정렬 힌트로 쓴다.
    bucket: minutes <= 5 ? "quick" : minutes <= 30 ? "normal" : "long",
  };
}

/** 작성자에게 보낼 한국어 코멘트 템플릿. 그대로 붙여넣을 수 있게 완성형으로 만든다. */
const TEMPLATE = {
  cla: (a) =>
    `@${a} 안녕하세요! 이 PR을 머지하려면 CNCF CLA 서명이 필요합니다. ` +
    `아래 봇 코멘트의 링크에서 서명해 주시면 \`cncf-cla: yes\` 로 바뀝니다. 감사합니다!`,
  rebase: (a) =>
    `@${a} 안녕하세요! master 와 충돌이 생겨 \`needs-rebase\` 라벨이 붙었습니다. ` +
    `rebase 후 force push 해주시면 리뷰를 이어가겠습니다. 도움이 필요하시면 편하게 말씀해 주세요.`,
  ci: (a) =>
    `@${a} 안녕하세요! CI 검사가 실패하고 있습니다. ` +
    `실패한 잡의 로그를 확인해 수정 후 push 부탁드립니다. 원인 파악이 어려우시면 알려주세요.`,
  idle: (a, d) =>
    `@${a} 안녕하세요! 이 PR이 ${d}일째 업데이트가 없습니다. ` +
    `계속 진행하실 계획이신지 알려주시면 좋겠습니다. 이어가기 어려우시면 다른 분께 넘겨도 괜찮습니다.`,
  rotten: (a) =>
    `@${a} 안녕하세요! 이 PR에 \`lifecycle/rotten\` 이 붙어 30일 뒤 자동으로 닫힙니다. ` +
    `계속 진행하시려면 \`/remove-lifecycle rotten\` 을 남겨 주세요.`,
};

/**
 * 열린 PR 하나를 하나의 레인 + 하나의 다음 행동으로 환원한다.
 * 위에서부터 첫 매치가 이긴다 — 순서 자체가 우선순위 정의다.
 */
function triage(pr) {
  const f = pr.flags;
  const a = pr.author;
  const ciFailed = (pr.ci?.failed?.length ?? 0) > 0;

  // 의도적으로 멈춘 것부터 걷어낸다. 당번이 볼 필요가 없다.
  if (pr.isDraft) {
    return { lane: "blocked", reason: "작성자가 draft 로 두었습니다", action: null };
  }
  if (f.hold) {
    const held = pr.labels.filter((l) => l.startsWith("do-not-merge")).join(", ");
    return { lane: "blocked", reason: `${held} 로 보류 중입니다`, action: null };
  }

  // 작성자만 풀 수 있는 차단 요소
  if (f.cncfUnsigned) {
    return {
      lane: "author",
      reason: "CLA 미서명 — 서명 전에는 머지 불가",
      action: { text: "CLA 서명 안내", command: null, comment: TEMPLATE.cla(a) },
    };
  }
  if (f.needsRebase) {
    return {
      lane: "author",
      reason: "master 와 충돌 — rebase 필요",
      action: { text: "rebase 요청", command: null, comment: TEMPLATE.rebase(a) },
    };
  }
  if (ciFailed) {
    return {
      lane: "author",
      reason: `CI 실패 (${pr.ci.failed.map((c) => c.name).join(", ")}) — 수정 전에는 머지 불가`,
      action: { text: "CI 수정 요청", command: null, comment: TEMPLATE.ci(a) },
    };
  }

  // 당번이 커맨드 하나로 푸는 것
  if (pr.labels.includes("needs-ok-to-test")) {
    return {
      lane: "review",
      reason: "외부 기여자 PR — CI 실행 승인 필요",
      action: { text: "CI 실행 승인", command: "/ok-to-test", comment: null },
    };
  }

  if (f.lgtm && f.approved) {
    return { lane: "merge", reason: "lgtm + approved — tide 머지 대기", action: null };
  }
  if (f.lgtm) {
    return {
      lane: "approve",
      reason: "lgtm 완료 — 어프루버 승인만 남음",
      action: { text: "어프루버 승인", command: "/approve", comment: null },
    };
  }

  // 여기까지 왔으면 차단 요소가 없다. 남은 질문은 "공이 누구 코트에 있나".
  if (pr.by === "reviewer") {
    return {
      lane: "author",
      reason: "리뷰 코멘트 이후 작성자 응답 대기",
      action:
        pr.idleDays >= 14
          ? { text: "작성자 핑", command: null, comment: TEMPLATE.idle(a, pr.idleDays) }
          : null,
    };
  }

  return {
    lane: "review",
    reason: !pr.touched
      ? "아직 리뷰어가 붙지 않음"
      : "작성자가 응답함 — 재확인 필요",
    action: { text: "리뷰 후 lgtm", command: "/lgtm", comment: null },
  };
}

const LANE_OURS = new Set(LANES.filter((l) => l.ours).map((l) => l.id));

/** 열린 PR 전체를 워크리스트 항목으로 변환한다. 나이 임계값으로 거르지 않는다. */
function buildQueue(prs) {
  return prs
    .filter((p) => p.state === "OPEN")
    .map((p) => {
      const t = triage(p);
      const cost = reviewCost(p);
      const rotten = p.labels.includes("lifecycle/rotten");
      const stale = p.labels.includes("lifecycle/stale");
      return {
        number: p.number,
        title: p.title,
        url: p.url,
        author: p.author,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        ageDays: p.ageDays,
        idleDays: p.idleDays,
        labels: p.labels,
        flags: p.flags,
        ci: p.ci?.state ?? "none",
        ciFailed: p.ci?.failed ?? [],
        changedFiles: p.changedFiles ?? 0,
        additions: p.additions ?? 0,
        deletions: p.deletions ?? 0,
        koOnly: p.koOnly ?? false,
        firstReview: !(p.touched ?? false),
        closingIssues: p.closingIssues ?? [],
        lane: t.lane,
        reason: t.reason,
        action: t.action,
        cost,
        // 봇이 붙인 lifecycle 라벨은 자동 종료 시계다. 당번 입장에선 마감 기한.
        lifecycle: rotten ? "rotten" : stale ? "stale" : null,
      };
    })
    .sort(
      (a, b) =>
        // 우리 차례를 먼저, 그 안에서는 오래 방치된 것부터
        Number(LANE_OURS.has(b.lane)) - Number(LANE_OURS.has(a.lane)) ||
        b.idleDays - a.idleDays ||
        a.number - b.number
    );
}

// ---------------------------------------------------------------------------
// 분류 규칙 (주간 백로그 뷰 — 기존 추이와의 연속성을 위해 유지)
// ---------------------------------------------------------------------------
function classify(issues, prs) {
  const { staleDays, longOpenDays, noPrDays } = CONFIG;

  // 1) Issue OPEN + 연결된 PR이 전부 CLOSED(미병합) → 작업이 중단된 상태
  const issuePrClosed = issues
    .filter((i) => {
      const prs = i.linkedPrs;
      return prs.length > 0 && prs.every((p) => p.state === "CLOSED");
    })
    .map((i) => ({ ...i, sortKey: i.idleDays }));

  // 2) Issue OPEN + 연결된 PR은 OPEN이지만 오래 갱신 없음 → 리뷰/응답 촉구 필요
  const issuePrStale = issues
    .filter((i) => {
      const open = i.linkedPrs.filter((p) => p.state === "OPEN");
      return open.length > 0 && open.every((p) => p.idleDays >= staleDays);
    })
    .map((i) => ({
      ...i,
      sortKey: Math.max(...i.linkedPrs.filter((p) => p.state === "OPEN").map((p) => p.idleDays)),
    }));

  // 3) Issue OPEN + 연결된 PR 자체가 없음 → 자원자 모집 필요
  const issueNoPr = issues
    .filter((i) => i.linkedPrs.length === 0 && i.ageDays >= noPrDays)
    .map((i) => ({ ...i, sortKey: i.ageDays }));

  // 4) 너무 오래 열려 있는 PR → 머지 또는 정리 결정 필요
  const prLongOpen = prs
    .filter((p) => p.state === "OPEN" && p.ageDays >= longOpenDays)
    .map((p) => ({ ...p, sortKey: p.ageDays }));

  const desc = (a, b) => b.sortKey - a.sortKey;

  return [
    {
      id: "issue-pr-closed",
      title: "Issue는 열려 있는데 PR이 닫힌 경우",
      hint: "번역 작업이 중단된 상태입니다. 이슈를 닫거나 새 자원자를 찾아야 합니다.",
      kind: "issue",
      metric: "마지막 활동",
      items: issuePrClosed.sort(desc),
    },
    {
      id: "issue-pr-stale",
      title: "Issue와 PR 모두 열려 있지만 정체된 경우",
      hint: `연결된 PR이 ${staleDays}일 이상 움직이지 않았습니다. 리뷰어를 지정하거나 작성자에게 확인하세요.`,
      kind: "issue",
      metric: "PR 미갱신",
      items: issuePrStale.sort(desc),
    },
    {
      id: "pr-long-open",
      title: "너무 오래 열려 있는 PR",
      hint: `${longOpenDays}일 이상 병합되지 않았습니다. lgtm/approved 여부를 확인하고 머지하거나 닫으세요.`,
      kind: "pr",
      metric: "오픈 경과",
      items: prLongOpen.sort(desc),
    },
    {
      id: "issue-no-pr",
      title: "PR이 없는 Issue",
      hint: `${noPrDays}일 이상 아무도 잡지 않았습니다. 주간 미팅에서 자원자를 배정하세요.`,
      kind: "issue",
      metric: "생성 경과",
      items: issueNoPr.sort(desc),
    },
  ];
}

// ---------------------------------------------------------------------------
// 스냅샷 & 추이 (append-only, git 히스토리를 시계열 저장소로 사용)
// ---------------------------------------------------------------------------

/** ISO 8601 주차: 목요일 기준. 같은 주 재실행은 같은 파일에 덮어써 멱등성 유지. */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // 목요일로 이동 (ISO 주는 목요일이 속한 해/주에 귀속)
  const dayNum = (d.getUTCDay() + 6) % 7; // 월=0 … 일=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((d - firstThursday) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** report 에서 추이용 집계만 추출 (수십 바이트) */
function summarize(report, week) {
  const bySec = Object.fromEntries(report.sections.map((s) => [s.id, s.items.length]));
  const byLane = Object.fromEntries(LANES.map((l) => [l.id, 0]));
  for (const item of report.queue) byLane[item.lane]++;
  return {
    week,
    generatedAt: report.generatedAt,
    openIssues: report.totals.openIssues,
    openPrs: report.totals.openPrs,
    // 당번 부담의 실제 척도: 열린 PR 총량이 아니라 "우리 차례"인 건수
    needsAction: byLane.review + byLane.approve,
    laneReview: byLane.review,
    laneApprove: byLane.approve,
    laneAuthor: byLane.author,
    issuePrClosed: bySec["issue-pr-closed"] ?? 0,
    issuePrStale: bySec["issue-pr-stale"] ?? 0,
    prLongOpen: bySec["pr-long-open"] ?? 0,
    issueNoPr: bySec["issue-no-pr"] ?? 0,
  };
}

/** 원본 스냅샷 저장 + keepWeeks 초과분 삭제(롤링). 집계는 건드리지 않는다. */
async function writeSnapshot(report, week) {
  await mkdir(CONFIG.snapshotDir, { recursive: true });
  const file = join(CONFIG.snapshotDir, `${week}.json`);
  await writeFile(file, JSON.stringify(report) + "\n", "utf8"); // 원본은 압축(비-pretty)

  // 롤링: 파일명(주차) 역순 정렬 후 keepWeeks 개만 남기고 삭제
  const files = (await readdir(CONFIG.snapshotDir))
    .filter((f) => /^\d{4}-W\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  const stale = files.slice(CONFIG.keepWeeks);
  for (const f of stale) await rm(join(CONFIG.snapshotDir, f));
  return { file, pruned: stale.length };
}

/** 추이 파일에 이번 주 집계를 upsert (같은 주 재실행 시 교체). 오래된 항목도 유지 = 영구 보관. */
async function upsertTrend(summary) {
  let trend = [];
  try {
    trend = JSON.parse(await readFile(CONFIG.trendOut, "utf8"));
    if (!Array.isArray(trend)) trend = [];
  } catch {
    /* 최초 실행: 파일 없음 */
  }
  const i = trend.findIndex((t) => t.week === summary.week);
  if (i >= 0) trend[i] = summary;
  else trend.push(summary);
  trend.sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));

  await mkdir(dirname(CONFIG.trendOut), { recursive: true });
  await writeFile(CONFIG.trendOut, JSON.stringify(trend, null, 2) + "\n", "utf8");
  return trend.length;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const base = `repo:${CONFIG.repo} label:"${CONFIG.label}" is:open`;

  console.log(`▸ ${CONFIG.repo} / ${CONFIG.label}`);

  console.log("▸ Issue 수집 중...");
  const rawIssues = await searchAll(ISSUE_QUERY, `${base} is:issue`);
  const issues = rawIssues.map(normalizeIssue);
  console.log(`  ${issues.length}건`);

  console.log("▸ PR 수집 중...");
  const rawPrs = await searchAll(PULL_QUERY, `${base} is:pr`);
  const prs = rawPrs.map(normalizePr);
  console.log(`  ${prs.length}건`);

  const sections = classify(issues, prs);
  const queue = buildQueue(prs);

  const report = {
    generatedAt: new Date().toISOString(),
    repo: CONFIG.repo,
    label: CONFIG.label,
    thresholds: {
      staleDays: CONFIG.staleDays,
      longOpenDays: CONFIG.longOpenDays,
      noPrDays: CONFIG.noPrDays,
    },
    totals: { openIssues: issues.length, openPrs: prs.length },
    lanes: LANES,
    queue,
    sections,
  };

  await mkdir(dirname(CONFIG.out), { recursive: true });
  await writeFile(CONFIG.out, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(`\n▸ ${CONFIG.out} 생성 완료`);
  console.log("  워크리스트 (열린 PR 전체)");
  for (const lane of LANES) {
    const n = queue.filter((q) => q.lane === lane.id).length;
    console.log(`  ${String(n).padStart(3)}  ${lane.ours ? "★" : " "} ${lane.title}`);
  }
  console.log("  주간 백로그");
  for (const s of sections) console.log(`  ${String(s.items.length).padStart(3)}    ${s.title}`);

  // ── 스냅샷 + 추이 ──────────────────────────────────────────────────────
  const week = isoWeek(new Date());
  const summary = summarize(report, week);
  const snap = await writeSnapshot(report, week);
  const trendLen = await upsertTrend(summary);

  console.log(`\n▸ 스냅샷 ${week} 저장 (원본 ${snap.pruned}개 롤링 삭제)`);
  console.log(`▸ 추이 ${trendLen}주치 누적 → ${CONFIG.trendOut}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
