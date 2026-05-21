// Vercel Serverless Function: /api/tasks
// Notion API 2025-09-03 (multi data source 지원)
// 1) GET /v1/databases/{id} 로 data source 목록 조회
// 2) 각 data source를 POST /v1/data_sources/{id}/query 로 조회

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

function getProp(page, name) { return page.properties?.[name]; }
function readTitle(prop) {
  if (!prop || prop.type !== "title") return "";
  return (prop.title || []).map(t => t.plain_text).join("");
}
function readSelect(prop) {
  if (!prop) return null;
  if (prop.type === "select") return prop.select?.name ?? null;
  if (prop.type === "status") return prop.status?.name ?? null;
  return null;
}
function readDate(prop) {
  if (!prop || prop.type !== "date" || !prop.date) return null;
  return prop.date.start || null;
}
function readPeople(prop) {
  if (!prop || prop.type !== "people") return [];
  return (prop.people || []).map(p => p.name || p.id);
}
function parsePriority(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function notionFetch(url, token, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!token || !databaseId) {
    res.status(500).json({ error: "NOTION_TOKEN 또는 NOTION_DATABASE_ID 환경변수가 설정되지 않았습니다." });
    return;
  }

  try {
    // 1) DB 메타 조회 → data_sources 목록
    const dbResp = await notionFetch(`${NOTION_API}/databases/${databaseId}`, token);
    if (!dbResp.ok) {
      const t = await dbResp.text();
      res.status(dbResp.status).json({ error: "Notion API error (database)", detail: t });
      return;
    }
    const db = await dbResp.json();
    const dataSources = db.data_sources || [];
    if (dataSources.length === 0) {
      res.status(500).json({ error: "Database에 data source가 없습니다." });
      return;
    }

    // 2) 각 data source를 조회 (Status != Completed 필터)
    const filter = {
      or: [
        { property: "Status", select: { does_not_equal: "Completed" } },
        { property: "Status", select: { is_empty: true } }
      ]
    };

    const tasks = [];
    for (const ds of dataSources) {
      let cursor = undefined;
      do {
        const body = { filter, page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const r = await notionFetch(`${NOTION_API}/data_sources/${ds.id}/query`, token, {
          method: "POST",
          body: JSON.stringify(body)
        });
        if (!r.ok) {
          const t = await r.text();
          res.status(r.status).json({
            error: "Notion API error (data source query)",
            dataSourceId: ds.id,
            detail: t
          });
          return;
        }
        const data = await r.json();
        for (const page of data.results || []) {
          const name = readTitle(getProp(page, "Name"));
          const status = readSelect(getProp(page, "Status"));
          const priorityStr = readSelect(getProp(page, "Priority"));
          const due = readDate(getProp(page, "Due Date"));
          const assignees = readPeople(getProp(page, "Assign"));
          tasks.push({
            id: page.id,
            name,
            status,
            priority: parsePriority(priorityStr),
            priorityLabel: priorityStr,
            due,
            assignees,
            url: page.url
          });
        }
        cursor = data.has_more ? data.next_cursor : undefined;
      } while (cursor);
    }

    res.status(200).json({
      snapshotAt: new Date().toISOString(),
      count: tasks.length,
      tasks,
      dataSourceCount: dataSources.length
    });
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: String(err) });
  }
};
