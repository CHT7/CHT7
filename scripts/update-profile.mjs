import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const login = (
  process.env.PROFILE_LOGIN ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  "CHT7"
).trim();
const token = process.env.PROFILE_TOKEN?.trim() || "";
const requireCompleteAccess =
  process.env.REQUIRE_COMPLETE_REPOSITORY_ACCESS === "true";
const apiBase = "https://api.github.com";
const oneDay = 24 * 60 * 60 * 1000;

function requestHeaders(authToken = token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `${login}-profile-cards`,
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };
}

async function requestJson(url, authToken = token) {
  const response = await fetch(url, { headers: requestHeaders(authToken) });
  if (!response.ok) {
    throw new Error(`GitHub API returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function graphQL(query, variables = {}) {
  const response = await fetch(`${apiBase}/graphql`, {
    method: "POST",
    headers: { ...requestHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL returned HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL: ${payload.errors[0].message}`);
  }
  return payload.data;
}

async function publicRepositoryCount() {
  const user = await requestJson(
    `${apiBase}/users/${encodeURIComponent(login)}`,
    "",
  );
  return { count: user.public_repos, createdAt: user.created_at };
}

async function authenticatedOwnedRepositoryCount() {
  let count = 0;
  for (let page = 1; ; page += 1) {
    const repositories = await requestJson(
      `${apiBase}/user/repos?visibility=all&affiliation=owner&per_page=100&page=${page}`,
    );
    count += repositories.filter(
      (repository) => repository.owner.login.toLowerCase() === login.toLowerCase(),
    ).length;
    if (repositories.length < 100) break;
  }
  return count;
}

async function authenticatedStats() {
  const identity = await graphQL(`
    query ProfileIdentity {
      viewer {
        id
        login
        createdAt
      }
    }
  `);

  if (identity.viewer.login.toLowerCase() !== login.toLowerCase()) {
    throw new Error("PROFILE_TOKEN belongs to a different GitHub account.");
  }

  const [authenticatedCount, publicData] = await Promise.all([
    authenticatedOwnedRepositoryCount(),
    publicRepositoryCount(),
  ]);
  if (requireCompleteAccess && authenticatedCount <= publicData.count) {
    throw new Error(
      "PROFILE_TOKEN cannot access the complete repository set. Update its repository scopes before rerunning.",
    );
  }

  const to = new Date();
  const from = new Date(to.getTime() - 364 * oneDay);
  const since = from.toISOString();
  const contributionData = await graphQL(
    `
      query ProfileActivity($from: DateTime!, $to: DateTime!) {
        viewer {
          contributionsCollection(from: $from, to: $to) {
            contributionCalendar {
              totalContributions
              weeks {
                contributionDays {
                  contributionCount
                  date
                }
              }
            }
          }
        }
      }
    `,
    { from: from.toISOString(), to: to.toISOString() },
  );

  const repositories = [];
  let after = null;
  do {
    const data = await graphQL(
      `
        query ProfileRepositories(
          $after: String
          $authorId: ID!
          $since: GitTimestamp!
        ) {
          viewer {
            repositories(
              first: 50
              after: $after
              ownerAffiliations: OWNER
              orderBy: { field: UPDATED_AT, direction: DESC }
            ) {
              pageInfo { hasNextPage endCursor }
              nodes {
                isFork
                stargazerCount
                languages(first: 12, orderBy: { field: SIZE, direction: DESC }) {
                  edges {
                    size
                    node { name color }
                  }
                }
                defaultBranchRef {
                  target {
                    ... on Commit {
                      history(first: 1, since: $since, author: { id: $authorId }) {
                        totalCount
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        after,
        authorId: identity.viewer.id,
        since,
      },
    );
    const connection = data.viewer.repositories;
    repositories.push(...connection.nodes);
    after = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);

  const calendar =
    contributionData.viewer.contributionsCollection.contributionCalendar;
  const commitCount = repositories.reduce(
    (sum, repository) =>
      sum +
      (repository.defaultBranchRef?.target?.history?.totalCount ?? 0),
    0,
  );

  return {
    complete: true,
    createdAt: identity.viewer.createdAt,
    totalRepositories: repositories.length,
    contributions: Math.max(calendar.totalContributions, commitCount),
    stars: repositories.reduce(
      (sum, repository) => sum + repository.stargazerCount,
      0,
    ),
    languages: collectLanguages(repositories),
    weeklyActivity: calendar.weeks.map((week) =>
      week.contributionDays.reduce(
        (sum, day) => sum + day.contributionCount,
        0,
      ),
    ),
  };
}

async function publicFallbackStats() {
  const repositories = [];
  for (let page = 1; ; page += 1) {
    const batch = await requestJson(
      `${apiBase}/users/${encodeURIComponent(login)}/repos?type=owner&sort=updated&per_page=100&page=${page}`,
      "",
    );
    repositories.push(...batch);
    if (batch.length < 100) break;
  }

  const enriched = await Promise.all(
    repositories.map(async (repository) => {
      const languages = await requestJson(repository.languages_url, "");
      return {
        isFork: repository.fork,
        stargazerCount: repository.stargazers_count,
        languages: {
          edges: Object.entries(languages).map(([name, size]) => ({
            size,
            node: { name, color: languageColor(name) },
          })),
        },
      };
    }),
  );
  const publicData = await publicRepositoryCount();

  return {
    complete: false,
    createdAt: publicData.createdAt,
    totalRepositories: repositories.length,
    contributions: 0,
    stars: repositories.reduce(
      (sum, repository) => sum + repository.stargazers_count,
      0,
    ),
    languages: collectLanguages(enriched),
    weeklyActivity: [],
  };
}

function languageColor(name) {
  const colors = {
    JavaScript: "#F1E05A",
    TypeScript: "#3178C6",
    Python: "#3572A5",
    Lua: "#000080",
    HTML: "#E34C26",
    CSS: "#563D7C",
    Shell: "#89E051",
    Vue: "#41B883",
  };
  return colors[name] || "#8B5CF6";
}

function collectLanguages(repositories) {
  const totals = new Map();
  for (const repository of repositories) {
    if (repository.isFork) continue;
    for (const edge of repository.languages?.edges || []) {
      const current = totals.get(edge.node.name) || {
        name: edge.node.name,
        color: edge.node.color || languageColor(edge.node.name),
        size: 0,
      };
      current.size += edge.size;
      totals.set(edge.node.name, current);
    }
  }

  const grandTotal = [...totals.values()].reduce(
    (sum, language) => sum + language.size,
    0,
  );
  return [...totals.values()]
    .sort((left, right) => right.size - left.size)
    .map((language) => ({
      ...language,
      percentage: grandTotal ? (language.size / grandTotal) * 100 : 0,
    }));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);
}

function themeColors(theme) {
  const dark = theme === "dark";
  return {
    background: dark ? "#0D1117" : "#FFFFFF",
    panel: dark ? "#151B23" : "#F6F8FA",
    border: dark ? "#30363D" : "#D0D7DE",
    text: dark ? "#F0F6FC" : "#1F2328",
    muted: dark ? "#8B949E" : "#59636E",
    purple: dark ? "#A78BFA" : "#7C3AED",
    cyan: dark ? "#2DD4BF" : "#009688",
  };
}

function statsSvg(stats, theme) {
  const color = themeColors(theme);
  const joinedYear = new Date(stats.createdAt).getUTCFullYear();
  const topLanguage = stats.languages[0]?.name || "JavaScript";
  const metrics = stats.complete
    ? [
        [formatNumber(stats.totalRepositories), "Repositories"],
        [formatNumber(stats.contributions), "Contributions"],
        [topLanguage, "Top language"],
        [String(joinedYear), "On GitHub since"],
      ]
    : [
        [login.toUpperCase(), "GitHub"],
        [String(joinedYear), "On GitHub since"],
        [topLanguage, "Top language"],
        ["Vietnam", "From"],
      ];

  const metricNodes = metrics
    .map(([value, label], index) => {
      const x = index % 2 === 0 ? 28 : 230;
      const y = index < 2 ? 82 : 156;
      const fontSize = String(value).length > 10 ? 18 : 25;
      return `<g transform="translate(${x} ${y})">
        <text class="value" style="font-size:${fontSize}px">${escapeXml(value)}</text>
        <text y="23" class="label">${escapeXml(label)}</text>
      </g>`;
    })
    .join("\n");

  const activity = stats.weeklyActivity.slice(-36);
  const max = Math.max(...activity, 1);
  const bars = activity
    .map((count, index) => {
      const height = Math.max(2, Math.round((count / max) * 24));
      return `<rect x="${28 + index * 10}" y="${233 - height}" width="6" height="${height}" rx="3"/>`;
    })
    .join("");
  const activityFooter = stats.complete
    ? `<g fill="${color.cyan}" opacity=".8">${bars}</g>
  <text x="28" y="250" class="label">last 12 months</text>`
    : `<text x="28" y="235" class="label">github.com/${escapeXml(login)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="260" viewBox="0 0 440 260" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(login)} GitHub stats</title>
  <desc id="desc">Repository, contribution and language statistics.</desc>
  <defs>
    <linearGradient id="accent" x1="0" x2="1">
      <stop stop-color="${color.purple}"/>
      <stop offset="1" stop-color="${color.cyan}"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .heading { fill: ${color.text}; font-size: 16px; font-weight: 700; }
    .eyebrow { fill: ${color.purple}; font-size: 10px; font-weight: 700; letter-spacing: 1.5px; }
    .value { fill: ${color.text}; font-weight: 750; }
    .label { fill: ${color.muted}; font-size: 11px; }
  </style>
  <rect x=".5" y=".5" width="439" height="259" rx="16" fill="${color.background}" stroke="${color.border}"/>
  <rect x="1" y="1" width="438" height="4" rx="2" fill="url(#accent)"/>
  <circle cx="32" cy="35" r="12" fill="${color.panel}" stroke="${color.border}"/>
  <path d="M36 27a9 9 0 1 0 0 16 10 10 0 1 1 0-16Z" fill="${color.purple}"/>
  <text x="53" y="32" class="eyebrow">CHT7</text>
  <text x="53" y="50" class="heading">GitHub stats</text>
  ${metricNodes}
  ${activityFooter}
</svg>
`;
}

function languagesSvg(stats, theme) {
  const color = themeColors(theme);
  const visible = stats.languages.slice(0, 5);
  const display = visible.length
    ? visible
    : [{ name: "JavaScript", percentage: 100, color: "#F1E05A" }];
  const normalizedTotal = display.reduce(
    (sum, language) => sum + language.percentage,
    0,
  );
  let cursor = 24;
  const segments = display
    .map((language, index) => {
      const width =
        index === display.length - 1
          ? 392 - (cursor - 24)
          : Math.max(3, (language.percentage / normalizedTotal) * 392);
      const node = `<rect x="${cursor.toFixed(1)}" y="67" width="${width.toFixed(1)}" height="10" fill="${language.color}"/>`;
      cursor += width;
      return node;
    })
    .join("");

  const rows = display
    .map((language, index) => {
      const y = 112 + index * 29;
      return `<g transform="translate(28 ${y})">
        <circle cx="5" cy="-4" r="5" fill="${language.color}"/>
        <text x="18" class="language">${escapeXml(language.name)}</text>
        <text x="382" text-anchor="end" class="percent">${language.percentage.toFixed(1)}%</text>
      </g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="260" viewBox="0 0 440 260" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(login)} language mix</title>
  <desc id="desc">Most used programming languages by repository size.</desc>
  <defs>
    <linearGradient id="accent" x1="0" x2="1">
      <stop stop-color="${color.cyan}"/>
      <stop offset="1" stop-color="${color.purple}"/>
    </linearGradient>
    <clipPath id="bar"><rect x="24" y="67" width="392" height="10" rx="5"/></clipPath>
  </defs>
  <style>
    text { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .heading { fill: ${color.text}; font-size: 16px; font-weight: 700; }
    .eyebrow { fill: ${color.cyan}; font-size: 10px; font-weight: 700; letter-spacing: 1.5px; }
    .language { fill: ${color.text}; font-size: 12px; font-weight: 600; }
    .percent { fill: ${color.muted}; font-size: 12px; font-variant-numeric: tabular-nums; }
  </style>
  <rect x=".5" y=".5" width="439" height="259" rx="16" fill="${color.background}" stroke="${color.border}"/>
  <rect x="1" y="1" width="438" height="4" rx="2" fill="url(#accent)"/>
  <text x="24" y="31" class="eyebrow">LANGUAGES</text>
  <text x="24" y="51" class="heading">Language mix</text>
  <g clip-path="url(#bar)">${segments}</g>
  ${rows}
</svg>
`;
}

async function main() {
  if (requireCompleteAccess && !token) {
    throw new Error("PROFILE_TOKEN is missing.");
  }
  const stats = token
    ? await authenticatedStats()
    : await publicFallbackStats();
  const assetsDirectory = path.resolve("assets");
  await mkdir(assetsDirectory, { recursive: true });

  await Promise.all([
    writeFile(
      path.join(assetsDirectory, "profile-stats-light.svg"),
      statsSvg(stats, "light"),
      "utf8",
    ),
    writeFile(
      path.join(assetsDirectory, "profile-stats-dark.svg"),
      statsSvg(stats, "dark"),
      "utf8",
    ),
    writeFile(
      path.join(assetsDirectory, "languages-light.svg"),
      languagesSvg(stats, "light"),
      "utf8",
    ),
    writeFile(
      path.join(assetsDirectory, "languages-dark.svg"),
      languagesSvg(stats, "dark"),
      "utf8",
    ),
  ]);

  console.log("Profile cards generated.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
