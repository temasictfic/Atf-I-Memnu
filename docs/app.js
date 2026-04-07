const fallbackRepo = {
  owner: "temasictfic",
  repo: "Atf-I-Memnu"
};

function inferRepoFromLocation() {
  const host = window.location.hostname;
  const pathParts = window.location.pathname.split("/").filter(Boolean);

  if (host.endsWith(".github.io") && pathParts.length > 0) {
    const owner = host.split(".")[0];
    const repo = pathParts[0];
    return { owner, repo };
  }

  return fallbackRepo;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "Unknown size";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value) {
  if (!value) {
    return "Unknown publish date";
  }

  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) {
    return "Unknown publish date";
  }

  return dt.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function createAssetElement(asset) {
  const row = document.createElement("article");
  row.className = "asset";

  const info = document.createElement("div");
  const name = document.createElement("div");
  name.className = "asset-name";
  name.textContent = asset.name || "Unnamed asset";

  const meta = document.createElement("div");
  meta.className = "asset-meta";
  meta.textContent = `${formatBytes(asset.size)} - Download count: ${asset.download_count ?? 0}`;

  info.append(name, meta);

  const action = document.createElement("a");
  action.className = "download-btn";
  action.href = asset.browser_download_url;
  action.target = "_blank";
  action.rel = "noreferrer";
  action.textContent = "Download";

  row.append(info, action);
  return row;
}

async function loadLatestRelease() {
  const repoInfo = inferRepoFromLocation();
  const releaseUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/releases/latest`;

  const status = document.getElementById("status");
  const releaseRoot = document.getElementById("releaseRoot");
  const repoTag = document.getElementById("repoTag");
  const allReleasesLink = document.getElementById("allReleasesLink");

  repoTag.textContent = `Repository: ${repoInfo.owner}/${repoInfo.repo}`;
  allReleasesLink.href = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/releases`;

  try {
    const response = await fetch(releaseUrl, {
      headers: {
        Accept: "application/vnd.github+json"
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API request failed (${response.status})`);
    }

    const release = await response.json();
    const assets = Array.isArray(release.assets) ? release.assets : [];

    document.getElementById("releaseTitle").textContent = release.name || release.tag_name || "Latest release";
    document.getElementById("releaseDate").textContent = `Published ${formatDate(release.published_at)}`;

    const releasePageLink = document.getElementById("releasePageLink");
    releasePageLink.href = release.html_url;

    const notes = document.getElementById("releaseNotes");
    notes.textContent = release.body?.trim() || "No release notes provided.";

    const assetList = document.getElementById("assetList");
    assetList.innerHTML = "";

    if (assets.length === 0) {
      const empty = document.createElement("p");
      empty.className = "asset-meta";
      empty.textContent = "No binary assets were attached to this release.";
      assetList.append(empty);
    } else {
      const sortedAssets = [...assets].sort((a, b) => (b.download_count ?? 0) - (a.download_count ?? 0));
      sortedAssets.forEach((asset) => {
        assetList.append(createAssetElement(asset));
      });
    }

    status.hidden = true;
    releaseRoot.hidden = false;
  } catch (error) {
    status.className = "status status-error";
    status.textContent = `Failed to load latest release. ${error instanceof Error ? error.message : "Unknown error"}`;
    releaseRoot.hidden = true;
  }
}

void loadLatestRelease();