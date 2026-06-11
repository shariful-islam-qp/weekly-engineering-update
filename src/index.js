require("dotenv").config();
const { getDatabaseId, runQuery } = require("./metabase");

// const US_DB = "qp_metabase";
// const EU_DB = "euqpdb2 - [QP-EU]";
// const GLOBAL_DB = "GLOBAL WAREHOUSE";
const GLOBAL_DB_ID = 172;
const US_DB_ID = 2;
const EU_DB_ID = 105;

// Returns Saturday–Friday date range for the current week.
// Week always starts on Saturday and ends on Friday.
function getWeekDateRange() {
	const today = new Date();
	const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
	const daysSinceSat = dayOfWeek === 6 ? 0 : dayOfWeek + 1;

	const start = new Date(today);
	start.setDate(today.getDate() - daysSinceSat);

	const end = new Date(start);
	end.setDate(start.getDate() + 6);

	const fmt = (d) => d.toISOString().split("T")[0];
	return { startDate: fmt(start), endDate: fmt(end) };
}

function radarBugSql(startDate, endDate) {
	return `
    SELECT *
    FROM rt_ticket
    WHERE product_id = 21
      AND channel_id IN (9)
      AND status < 99 AND status != 96
      AND issue_type < 6
      AND ts BETWEEN '${startDate}' AND '${endDate}'
  `;
}

function fiveHundredErrorSql(startDate, endDate) {
	return `
    SELECT *
    FROM akira_xa3.error_log
    WHERE
        status = 500
        AND environment = "qpprod"
        AND path != "/api/health"
        AND path NOT LIKE '%pathos%'
        AND path NOT LIKE '%text-ai%'
        AND created_at BETWEEN '${startDate}' AND '${endDate}'
    ORDER BY id DESC
  `;
}

async function main() {
	const sessionToken = process.env.METABASE_SESSION_TOKEN;
	if (!sessionToken) {
		console.error("Error: METABASE_SESSION_TOKEN is not set.");
		console.error("Create a .env file or export the variable before running.");
		process.exit(1);
	}

	const { startDate, endDate } = getWeekDateRange();

	const queries = [
		{
			key: "radarBugs",
			dbId: GLOBAL_DB_ID,
			sql: radarBugSql(startDate, endDate),
		},
		{
			key: "errors500Us",
			dbId: US_DB_ID,
			sql: fiveHundredErrorSql(startDate, endDate),
		},
		{
			key: "errors500Eu",
			dbId: EU_DB_ID,
			sql: fiveHundredErrorSql(startDate, endDate),
		},
	];

	console.log(`Running ${queries.length} queries in parallel...\n`);

	const rawResults = await Promise.all(
		queries.map(({ key, dbId, sql }) =>
			runQuery(sessionToken, dbId, sql)
				.then((result) => ({ key, result, error: null }))
				.catch((err) => ({ key, result: null, error: err.message })),
		),
	);

	const byKey = Object.fromEntries(rawResults.map((r) => [r.key, r]));

	const fmtDate = (dateStr) => {
		const [y, m, d] = dateStr.split("-");
		return new Date(y, m - 1, d).toLocaleDateString("en-US", {
			month: "long",
			day: "numeric",
			year: "numeric",
		});
	};

	const colValues = (result, colName) => {
		const idx = result.data.cols.findIndex(
			(c) => c.name.toLowerCase() === colName.toLowerCase(),
		);
		if (idx === -1) return result.data.rows.map(() => null);
		return result.data.rows.map((row) => row[idx] ?? null);
	};
	const lines = [];
	const line = (text) => lines.push(text);
	const blank = () => lines.push("");

	line("--------------------------------");
	blank();
	line(`Engineering weekly updates: ${fmtDate(startDate)} - ${fmtDate(endDate)}`);
	blank();

	// Radar bugs
	const radarBugs = byKey.radarBugs;
	if (radarBugs.error) {
		line(`Radar Bugs error: ${radarBugs.error}`);
	} else {
		const subjects = colValues(radarBugs.result, "subject");
		line(`Radar Bug Count: ${subjects.length}`);
		blank();
		subjects.forEach((s, i) =>
			line(`${String.fromCharCode(97 + i)}. ${s ?? "N/A"}`),
		);
	}

	blank();

	// 500 errors
	const errUs = byKey.errors500Us;
	const errEu = byKey.errors500Eu;
	const usMessages = errUs.error ? [] : colValues(errUs.result, "message");
	const euMessages = errEu.error ? [] : colValues(errEu.result, "message");
	const usCount = errUs.error ? "ERR" : usMessages.length;
	const euCount = errEu.error ? "ERR" : euMessages.length;

	line(`500 Errors: ${usCount} (US) ${euCount} (EU)`);
	blank();
	if (errUs.error) line(`US error: ${errUs.error}`);
	else
		usMessages.forEach((m, i) =>
			line(`${String.fromCharCode(97 + i)}. ${m ?? "N/A"}`),
		);
	if (errEu.error) line(`EU error: ${errEu.error}`);
	else
		euMessages.forEach((m, i) =>
			line(`${String.fromCharCode(97 + i)}. ${m ?? "N/A"}`),
		);

	console.log(lines.join("\n"));
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
