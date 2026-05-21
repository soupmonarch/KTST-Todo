// Vercel Serverless Function: /api/tasks
// Notion API 2025-09-03 (multi data source 지원)
// 스키마: Sub-Task(title), Status, Urgency, Importance, Due Date, Start Date,
//         Lead, Task Owner, Category 1/2/3, Task, EPIC, Project, Customer

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
function readText(prop) {
  if (!prop) return "";
  if (prop.type === "rich_text") return (prop.rich_text || []).map(t => t.plain_text).join("");
  if (prop.type === "title") return (prop.title || []).map(t => t.plain_text).join("");
  return "";
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
function readRelationIds(prop) {
  if (!prop || prop.type !== "relation") return [];
  return (prop.relation || []).map(r => r.id);
}
function parseNum(s) {
  if (s == null) return null;
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
      // 2) data source 스키마 조회
      const schemaResp = await notionFetch(`${NOTION_API}/data_sources/${ds.id}`, token);
      if (!schemaResp.ok) {
        skipped.push({ id: ds.id, reason: `schema fetch failed (${schemaResp.status})` });
        continue;
      }
      const schema = await schemaResp.json();
      const props = schema.properties || {};

      // 3) 속성 이름 자동 감지
      const titleKey      = findPropByName(props, ["Sub-Task", "Subtask", "Sub Task", "Name", "Title", "이름", "제목"]) || findPropByType(props, "title");
      const statusKey     = findPropByName(props, ["Status", "상태"]);
      const urgencyKey    = findPropByName(props, ["Urgency", "긴급도"]);
      const importanceKey = findPropByName(props, ["Importance", "중요도", "Priority", "우선순위"]);
      const dueKey        = findPropByName(props, ["Due Date", "Due", "Deadline", "마감일"]);
      const startKey      = findPropByName(props, ["Start Date", "Start", "시작일"]);
      const leadKey       = findPropByName(props, ["Lead", "리드"]);
      const ownerKey      = findPropByName(props, ["Task Owner", "Owner", "Assign", "Assignee", "담당자"]);
      const cat1Key       = findPropByName(props, ["Category 1", "Category1"]);
      const cat2Key       = findPropByName(props, ["Category 2", "Category2"]);
      const cat3Key       = findPropByName(props, ["Category 3", "Category3"]);
      const taskKey       = findPropByName(props, ["Task"]);
      const epicKey       = findPropByName(props, ["EPIC", "Epic"]);
      const projectKey    = findPropByName(props, ["Project", "프로젝트"]);
      const customerKey   = findPropByName(props, ["Customer", "고객"]);

      if (!titleKey) {
        skipped.push({ id: ds.id, reason: "no title property" });
        continue;
      }

      // 4) 조건부 필터 (Status 속성이 있을 때만)
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
          const status = statusKey ? readSelect(page.properties?.[statusKey]) : null;
          if (status === "Completed") continue;
          tasks.push({
            id: page.id,
            name: readTitle(page.properties?.[titleKey]),
            status,
            urgency: urgencyKey ? parseNum(readSelect(page.properties?.[urgencyKey])) : null,
            urgencyLabel: urgencyKey ? readSelect(page.properties?.[urgencyKey]) : null,
            importance: importanceKey ? parseNum(readSelect(page.properties?.[importanceKey])) : null,
            importanceLabel: importanceKey ? readSelect(page.properties?.[importanceKey]) : null,
            due: dueKey ? readDate(page.properties?.[dueKey]) : null,
            start: startKey ? readDate(page.properties?.[startKey]) : null,
            lead: leadKey ? readPeople(page.properties?.[leadKey]) : [],
            owner: ownerKey ? readPeople(page.properties?.[ownerKey]) : [],
            category1: cat1Key ? readSelect(page.properties?.[cat1Key]) : null,
            category2: cat2Key ? readSelect(page.properties?.[cat2Key]) : null,
            category3: cat3Key ? readSelect(page.properties?.[cat3Key]) : null,
            task: taskKey ? readText(page.properties?.[taskKey]) : "",
            epic: epicKey ? readText(page.properties?.[epicKey]) : "",
            projectIds: projectKey ? readRelationIds(page.properties?.[projectKey]) : [],
            customerIds: customerKey ? readRelationIds(page.properties?.[customerKey]) : [],
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
