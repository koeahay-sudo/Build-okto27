const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const CONFIG = require('./config');

function getHeaders(creds) {
  const token = creds?.token || CONFIG.githubToken;
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function parseRepo(creds) {
  const repo = creds?.repo || CONFIG.githubRepositories[0];
  const [owner, name] = repo.split('/');
  return { owner, name };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function githubRequest(method, path, data, creds) {
  const { owner, name } = parseRepo(creds);
  const url = `https://api.github.com/repos/${owner}/${name}${path}`;
  const res = await axios({ method, url, headers: getHeaders(creds), data, timeout: 30000 });
  return res.data;
}

async function createReleaseOnly(tag, creds) {
  const { owner, name } = parseRepo(creds);
  const res = await axios.post(
    `https://api.github.com/repos/${owner}/${name}/releases`,
    { tag_name: tag, name: tag, draft: true, prerelease: true },
    { headers: getHeaders(creds), timeout: 30000 }
  );
  return { releaseId: res.data.id, uploadUrl: res.data.upload_url.split('{')[0] };
}

async function uploadZipToRelease(zipPath, fileName, tag, creds) {
  const { releaseId, uploadUrl } = await createReleaseOnly(tag, creds);
  const fileBuffer = fs.readFileSync(zipPath);
  await axios.post(
    `${uploadUrl}?name=${encodeURIComponent(fileName)}`,
    fileBuffer,
    {
      headers: {
        ...getHeaders(creds),
        'Content-Type': 'application/zip',
        'Content-Length': fileBuffer.length,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000,
    }
  );
  const { owner, name } = parseRepo(creds);
  const browserUrl = `https://github.com/${owner}/${name}/releases/tag/${tag}`;
  return { releaseId, browserUrl };
}

async function publishRelease(releaseId, creds) {
  const { owner, name } = parseRepo(creds);
  const res = await axios.patch(
    `https://api.github.com/repos/${owner}/${name}/releases/${releaseId}`,
    { draft: false },
    { headers: getHeaders(creds), timeout: 30000 }
  );
  const assets = res.data.assets || [];
  return assets[0]?.browser_download_url || null;
}

async function triggerWorkflow(browserUrl, tag, buildType, creds) {
  const { owner, name } = parseRepo(creds);
  await axios.post(
    `https://api.github.com/repos/${owner}/${name}/actions/workflows/build.yml/dispatches`,
    { ref: 'main', inputs: { tag, build_type: buildType } },
    { headers: getHeaders(creds), timeout: 30000 }
  );
  await sleep(5000);
  const runs = await axios.get(
    `https://api.github.com/repos/${owner}/${name}/actions/runs?per_page=5`,
    { headers: getHeaders(creds), timeout: 30000 }
  );
  const run = runs.data.workflow_runs[0];
  return run?.id;
}

async function getRunStatus(runId, creds) {
  const { owner, name } = parseRepo(creds);
  const res = await axios.get(
    `https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}`,
    { headers: getHeaders(creds), timeout: 30000 }
  );
  const run = res.data;
  const createdAt = new Date(run.created_at).getTime();
  const updatedAt = new Date(run.updated_at).getTime();
  const durationSec = Math.floor((updatedAt - createdAt) / 1000);
  return { status: run.status, conclusion: run.conclusion, durationSec };
}

async function getArtifacts(runId, creds) {
  const { owner, name } = parseRepo(creds);
  const res = await axios.get(
    `https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}/artifacts`,
    { headers: getHeaders(creds), timeout: 30000 }
  );
  return res.data.artifacts || [];
}

async function downloadArtifactZip(artifactId, destPath, creds) {
  const { owner, name } = parseRepo(creds);
  const res = await axios.get(
    `https://api.github.com/repos/${owner}/${name}/actions/artifacts/${artifactId}/zip`,
    {
      headers: getHeaders(creds),
      responseType: 'arraybuffer',
      timeout: 300000,
      maxContentLength: Infinity,
    }
  );
  fs.writeFileSync(destPath, Buffer.from(res.data));
}

async function deleteRelease(releaseId, creds) {
  const { owner, name } = parseRepo(creds);
  await axios.delete(
    `https://api.github.com/repos/${owner}/${name}/releases/${releaseId}`,
    { headers: getHeaders(creds), timeout: 30000 }
  ).catch(() => {});
  await axios.delete(
    `https://api.github.com/repos/${owner}/${name}/git/refs/tags/${releaseId}`,
    { headers: getHeaders(creds), timeout: 30000 }
  ).catch(() => {});
}

async function getFailedStepLog(runId, creds) {
  try {
    const { owner, name } = parseRepo(creds);
    const jobs = await axios.get(
      `https://api.github.com/repos/${owner}/${name}/actions/runs/${runId}/jobs`,
      { headers: getHeaders(creds), timeout: 30000 }
    );
    const failedJob = jobs.data.jobs?.find(j => j.conclusion === 'failure');
    if (!failedJob) return null;
    const failedStep = failedJob.steps?.find(s => s.conclusion === 'failure');
    const logsRes = await axios.get(
      `https://api.github.com/repos/${owner}/${name}/actions/jobs/${failedJob.id}/logs`,
      { headers: getHeaders(creds), timeout: 30000, responseType: 'text' }
    );
    const logText = logsRes.data || '';
    const errorLines = logText
      .split('\n')
      .filter(l => /error|Error|FAILED|Exception/i.test(l))
      .slice(0, 30);
    return { stepName: failedStep?.name || failedJob.name, errorLines };
  } catch {
    return null;
  }
}

async function backupToGithub(dataPath, creds) {
  try {
    const { owner, name } = parseRepo(creds);
    const content = fs.readFileSync(dataPath);
    const encoded = content.toString('base64');
    let sha;
    try {
      const existing = await axios.get(
        `https://api.github.com/repos/${owner}/${name}/contents/database/bot.json`,
        { headers: getHeaders(creds), timeout: 15000 }
      );
      sha = existing.data.sha;
    } catch {}
    await axios.put(
      `https://api.github.com/repos/${owner}/${name}/contents/database/bot.json`,
      {
        message: `Auto-backup: ${new Date().toISOString()}`,
        content: encoded,
        sha,
      },
      { headers: getHeaders(creds), timeout: 30000 }
    );
  } catch (e) {
    console.error('[GitHub Backup]', e.message);
  }
}

module.exports = {
  githubRequest, uploadZipToRelease, deleteRelease,
  triggerWorkflow, getRunStatus, getArtifacts,
  downloadArtifactZip, getFailedStepLog, sleep,
  createReleaseOnly, publishRelease, backupToGithub,
};
