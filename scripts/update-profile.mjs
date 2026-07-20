import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const login = (
  process.env.PROFILE_LOGIN ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  "CHT7"
).trim();

const profileToken = process.env.PROFILE_TOKEN?.trim() || "";
const apiToken = profileToken || process.env.GH_TOKEN?.trim() || "";
const apiBase = "https://api.github.com";

const headers = (token = apiToken) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": `${login}-profile-metrics`,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

async function requestJson(url, token = apiToken) {
  const response = await fetch(url, { headers: headers(token) });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

async function paginatedRepositories() {
  const repositories = [];
  const privateAggregationEnabled = Boolean(profileToken);

  if (privateAggregationEnabled) {
    const viewer = await requestJson(`${apiBase}/user`, profileToken);
    if (viewer.login.toLowerCase() !== login.toLowerCase()) {
      throw new Error("PROFILE_TOKEN does not belong to PROFILE_LOGIN.");
    }
  }

  for (let page = 1; ; page += 1) {
    const url = privateAggregationEnabled
      ? `${apiBase}/user/repos?visibility=all&affiliation=owner&sort=updated&per_page=100&page=${page}`
      : `${apiBase}/users/${encodeURIComponent(login)}/repos?type=owner&sort=updated&per_page=100&page=${page}`;
    const batch = await requestJson(url, privateAggregationEnabled ? profileToken : "");
    const owned = batch.filter(
      (repository) => repository.owner.login.toLowerCase() === login.toLowerCase(),
    );
    repositories.push(...owned);
    if (batch.length < 100) break;
  }

  return { repositories, privateAggregationEnabled };
}

async function contributionCount() {
  if (!apiToken) return null;

  const to = new Date();
  const from = new Date(to.getTime() - 364 * 24 * 60 * 60 * 1000);
  const query = `
    query ProfileContributions($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar { totalContributions }
        }
      }
    }
  `;

  const response = await fetch(`${apiBase}/graphql`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { login, from: from.toISOString(), to: to.toISOString() },
    }),
  });

  if (!response.ok) return null;
  const payload = await response.json();
  return payload.data?.user?.contributionsCollection?.contributionCalendar
    ?.totalContributions ?? null;
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
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

function cardSvg(stats, theme) {
  const dark = theme === "dark";
  const color = {
    background: dark ? "#090B13" : "#F7F8FC",
    panel: dark ? "#111522" : "#FFFFFF",
    panelBorder: dark ? "#252B3D" : "#DDE1EB",
    title: dark ? "#F5F7FF" : "#171927",
    muted: dark ? "#8F98AE" : "#667085",
    accent: dark ? "#8B7CFF" : "#6957E8",
    cyan: dark ? "#38D6C7" : "#0A9F94",
  };

  const repositoryTotal = stats.privateAggregationEnabled
    ? formatNumber(stats.totalRepositories)
    : `${formatNumber(stats.publicRepositories)}+`;
  const status = stats.privateAggregationEnabled
    ? "PRIVATE AGGREGATES ON"
    : "PUBLIC FALLBACK";
  const note = stats.privateAggregationEnabled
    ? "Private work is counted only in aggregate — no names, URLs, or metadata are published."
    : "Add PROFILE_TOKEN to include private repositories; public data is shown for now.";

  const metrics = [
    [repositoryTotal, "TOTAL REPOSITORIES", stats.privateAggregationEnabled ? "public + private" : "minimum known"],
    [formatNumber(stats.publicRepositories), "PUBLIC PROJECTS", "visible to everyone"],
    [formatNumber(stats.contributions), "CONTRIBUTIONS", "last 12 months"],
    [formatNumber(stats.publicStars), "PUBLIC STARS", "across owned repos"],
  ];

  const panels = metrics
    .map(([value, label, detail], index) => {
      const x = 30 + index * 215;
      return `
        <g transform="translate(${x} 70)">
          <rect width="195" height="115" rx="16" fill="${color.panel}" stroke="${color.panelBorder}"/>
          <rect x="16" y="18" width="28" height="4" rx="2" fill="${index % 2 ? color.cyan : color.accent}"/>
          <text x="16" y="64" class="metric">${escapeXml(value)}</text>
          <text x="16" y="87" class="label">${escapeXml(label)}</text>
          <text x="16" y="104" class="detail">${escapeXml(detail)}</text>
        </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="245" viewBox="0 0 900 245" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(login)} GitHub statistics</title>
  <desc id="description">Aggregate repository, contribution, and star statistics.</desc>
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop stop-color="${color.accent}"/>
      <stop offset="1" stop-color="${color.cyan}"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .eyebrow { font-size: 12px; font-weight: 700; letter-spacing: 1.5px; fill: ${color.muted}; }
    .status { font-size: 10px; font-weight: 700; letter-spacing: 1px; fill: ${color.accent}; }
    .metric { font-size: 32px; font-weight: 750; fill: ${color.title}; }
    .label { font-size: 10px; font-weight: 700; letter-spacing: 1px; fill: ${color.title}; }
    .detail { font-size: 10px; fill: ${color.muted}; }
    .note { font-size: 11px; fill: ${color.muted}; }
  </style>
  <rect width="900" height="245" rx="22" fill="${color.background}"/>
  <rect width="900" height="4" rx="2" fill="url(#accent)"/>
  <text x="30" y="42" class="eyebrow">GITHUB / ${escapeXml(login.toUpperCase())}</text>
  <g transform="translate(708 23)">
    <rect width="162" height="28" rx="14" fill="${color.panel}" stroke="${color.panelBorder}"/>
    <circle cx="15" cy="14" r="4" fill="${stats.privateAggregationEnabled ? color.cyan : color.muted}"/>
    <text x="27" y="18" class="status">${status}</text>
  </g>
${panels}
  <text x="450" y="220" text-anchor="middle" class="note">${escapeXml(note)}</text>
</svg>
`;
}

async function main() {
  const [{ repositories, privateAggregationEnabled }, contributions] =
    await Promise.all([paginatedRepositories(), contributionCount()]);

  const publicRepositories = repositories.filter(
    (repository) => !repository.private,
  );
  const stats = {
    privateAggregationEnabled,
    totalRepositories: repositories.length,
    publicRepositories: publicRepositories.length,
    contributions,
    publicStars: publicRepositories.reduce(
      (total, repository) => total + repository.stargazers_count,
      0,
    ),
  };

  const assetsDirectory = path.resolve("assets");
  await mkdir(assetsDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(assetsDirectory, "profile-stats-light.svg"),
      cardSvg(stats, "light"),
      "utf8",
    ),
    writeFile(
      path.join(assetsDirectory, "profile-stats-dark.svg"),
      cardSvg(stats, "dark"),
      "utf8",
    ),
  ]);

  console.log(
    `Profile cards generated (private aggregation: ${privateAggregationEnabled ? "enabled" : "disabled"}).`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
