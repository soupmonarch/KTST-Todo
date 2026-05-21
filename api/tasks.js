// Vercel Serverless Function: /api/tasks
// Notion API로 KTST to-do 데이터베이스를 조회해서 간소화된 태스크 목록을 반환합니다.

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28"; // 안정적인 버전

function getProp(page, name) {
  return page.properties?.[name];
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

// Priority 문자열을 숫자 1~5로 변환 ("5 (High)" -> 5, "1 (Low)" -> 1)
function parsePriority(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = async (req, res) => {
  // CORS (Notion embed 등 외부 임베드에서도 호출 가능하도록)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!token || !databaseId) {
    res.status(500).json({
      error: "NOTION_TOKEN 또는 NOTION_DATABASE_ID 환경변수가 설정되지 않았습니다."
    });
    return;
  }

  try {
    // Notion DB 조회 (필터: Completed 제외)
    const body = {
      filter: {
        or: [
          { property: "Status", select: { does_not_equal: "Completed" } },
          { property: "Status", select: { is_empty: true } }
        ]
      },
      page_size: 100
    };

    const tasks = [];
    let cursor = undefined;
    do {
      const payload = cursor ? { ...body, start_cursor: cursor } : body;
      const r = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const t = await r.text();
        res.status(r.status).json({ error: "Notion API error", detail: t });
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

    res.status(200).json({
      snapshotAt: new Date().toISOString(),
      count: tasks.length,
      tasks
    });
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: String(err) });
  }
};
