// Vercel Serverless Function: /api/tasks
// Notion API 2025-09-03 (multi data source 지원)
// - DB 안의 여러 data source를 순회
// - 각 data source의 스키마를 먼저 조회해서 있는 속성에 맞게 필터/매핑
// - Name 또는 title 속성이 없는 data source는 건너뜀

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

function findPropByType(props, type) {
  for (const [name, def] of Object.entries(props || {})) {
    if (def.type === type) return name;
  }
  return null;
}
function findPropByName(props, candidates) {
  if (!props) return null;
  const lower = Object.keys(props).reduce((acc, k) => { acc[k.toLowerCase()] = k; return acc; }, {});
  for (const c of candidates) {
    const hit = lower[c.toLowerCase()];
    if (hit) return hit;
  }
  return null;
}

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
    // 1) DB 메타 조회
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

    const tasks = [];
    const skipped = [];

    for (const ds of dataSources) {
      // 1.5) 이 data source의 스키마 조회
      const schemaResp = await notionFetch(`${NOTION_API}/data_sources/${ds.id}`, token);
      if (!schemaResp.ok) {
        skipped.push({ id: ds.id, reason: `schema fetch failed (${schemaResp.status})` });
        continue;
      }
      const schema = await schemaResp.json();
      const props = schema.properties || {};

      // 속성 이름 자동 감지 (소문자 무관)
      const titleKey = findPropByName(props, ["Name", "Title", "이름", "제목"]) || findPropByType(props, "title");
      const statusKey = findPropByName(props, ["Status", "상태"]);
      const priorityKey = findPropByName(props, ["Priority", "우선순위"]);
      const dueKey = findPropByName(props, ["Due Date", "Due", "Deadline", "마감일"]);
      const assignKey = findPropByName(props, ["Assign", "Assignee", "담당자"]);

      if (!titleKey) {
        skipped.push({ id: ds.id, reason: "no title property" });
        continue;
      }

      // 2) 조건부 필터 (Status 속성이 있을 때만)
      const body = { page_size: 100 };
      const statusProp = statusKey ? props[statusKey] : null;
      if (statusKey && statusProp) {
        if (statusProp.type === "select") {
          body.filter = {
            or: [
              { property: statusKey, select: { does_not_equal: "Completed" } },
              { property: statusKey, select: { is_empty: true } }
            ]
          };
        } else if (statusProp.type === "status") {
          body.filter = {
            or: [
              { property: statusKey, status: { does_not_equal: "Completed" } },
              { property: statusKey, status: { is_empty: true } }
            ]
          };
        }
      }

      let cursor = undefined;
      do {
        const reqBody = { ...body };
        if (cursor) reqBody.start_cursor = cursor;
        const r = await notionFetch(`${NOTION_API}/data_sources/${ds.id}/query`, token, {
          method: "POST",
          body: JSON.stringify(reqBody)
        });
        if (!r.ok) {
          const t = await r.text();
          skipped.push({ id: ds.id, reason: `query failed (${r.status})`, detail: t });
          break;
        }
        const data = await r.json();
        for (const page of data.results || []) {
          const name = readTitle(page.properties?.[titleKey]);
          const status = statusKey ? readSelect(page.properties?.[statusKey]) : null;
          const priorityStr = priorityKey ? readSelect(page.properties?.[priorityKey]) : null;
          const due = dueKey ? readDate(page.properties?.[dueKey]) : null;
          const assignees = assignKey ? readPeople(page.properties?.[assignKey]) : [];
          // 클라이언트에서도 Completed 걸러내기 (filter 적용 안된 data source 용)
          if (status === "Completed") continue;
          tasks.push({
            id: page.id,
            name,
            status,
            priority: parsePriority(priorityStr),
            priorityLabel: priorityStr,
            due,
            assignees,
            url: page.url,
            dataSourceId: ds.id
          });
        }
        cursor = data.has_more ? data.next_cursor : undefined;
      } while (cursor);
    }

    res.status(200).json({
      snapshotAt: new Date().toISOString(),
      count: tasks.length,
      tasks,
      dataSourceCount: dataSources.length,
      skipped
    });
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: String(err) });
  }
};
