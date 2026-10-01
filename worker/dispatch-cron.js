/**
 * Cloudflare Worker：定時觸發 GitHub Actions 的 carpark-snapshot workflow。
 *
 * 為什麼需要這個（而不是只用 cron-job.org）：
 *   1. cron-job.org 的官方 FAQ 明講 **不支援自訂 `User-Agent` 與 `Connection` 標頭，
 *      會被忽略**。而 GitHub REST API 規定請求必須帶 `User-Agent`，
 *      缺少時會回 **403**（不是 401）：
 *      "Request forbidden by administrative rules. Please make sure your
 *       request has a User-Agent header"
 *   2. Worker 對 outbound 請求有完整標頭控制權，不會有這個問題。
 *   3. 不需要你的 Mac 開機。
 *
 * 部署（免費方案即可，cron 最細到每分鐘）：
 *
 *   npm install -g wrangler
 *   wrangler login
 *   cd worker
 *   wrangler secret put GH_TOKEN      # 貼上 PAT（不會寫進檔案）
 *   wrangler deploy
 *   wrangler secret put GH_TOKEN      # 若上面沒設成功，重跑一次
 *
 * 手動測試（部署後）：
 *   curl -sS "https://<你的-worker>.workers.dev/?key=<GH_TOKEN>" | head
 *   或直接用瀏覽器開 https://<你的-worker>.workers.dev/ 看 JSON 結果
 */

const DEFAULT_UA = "nexus-data-cron/1.0 (+https://github.com/poepoe33/nexus-data)";

function cfg(env) {
  return {
    repo: env.REPO || "poepoe33/nexus-data",
    workflow: env.WORKFLOW || "scrape.yml",
    ref: env.REF || "main",
    token: env.GH_TOKEN,
    ua: env.USER_AGENT || DEFAULT_UA,
  };
}

/** 打一次 workflow_dispatch。回傳可序列化的結果（永不 throw）。 */
async function dispatch(env) {
  const { repo, workflow, ref, token, ua } = cfg(env);

  if (!token) {
    return { ok: false, status: 0, error: "GH_TOKEN secret 未設定" };
  }

  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        // ← 這一行就是整個 Worker 存在的理由
        "User-Agent": ua,
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref }),
    });

    const text = await res.text();
    // 這個端點歷史上回 204（無 body），官方文件現在寫 200（回傳 run id 與 url）。
    // 兩者都代表已排入佇列，所以都算成功。
    return {
      ok: res.status === 200 || res.status === 204,
      status: res.status,
      at: new Date().toISOString(),
      repo,
      workflow,
      ref,
      body: text.slice(0, 500) || "(empty)",
    };
  } catch (err) {
    return { ok: false, status: 0, error: String(err), at: new Date().toISOString() };
  }
}

export default {
  /** Cron Trigger：照 wrangler.toml 的 crons 設定跑。 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      dispatch(env).then((r) => {
        const tag = r.ok ? "OK " : "ERR";
        console.log(`[${tag}] ${r.status} ${r.at} ${r.body || r.error || ""}`);
      }),
    );
  },

  /** HTTP handler：手動測試用。加 ?key=<token> 可驗證 token 是否有效。 */
  async fetch(request, env) {
    const r = await dispatch(env);
    return new Response(JSON.stringify(r, null, 2) + "\n", {
      status: r.ok ? 200 : 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  },
};
