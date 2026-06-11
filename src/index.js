require("dotenv").config();
const { getDatabaseId, runQuery } = require("./metabase");
const { displayResults } = require("./display");

// const US_DB = "qp_metabase";
// const EU_DB = "euqpdb2 - [QP-EU]";
// const GLOBAL_DB = "GLOBAL WAREHOUSE";
const GLOBAL_DB_ID = 172;

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
    SELECT COUNT(1) AS radar_bug_count
    FROM rt_ticket
    WHERE product_id = 21
      AND channel_id IN (9)
      AND status < 99 AND status != 96
      AND issue_type < 6
      AND ts BETWEEN '${startDate}' AND '${endDate}'
  `;
}

// function fiveHundredErrorSql(startDate, endDate) {
// 	return `
//     SELECT *
//     FROM akira_xa3.error_log
//     WHERE
//         status = 500
//         AND environment = "qpprod"
//         AND path !="/api/health"
//         AND path NOT LIKE '%pathos%'
//         AND path NOT LIKE '%text-ai%'
//         AND created_at BETWEEN '${startDate}' AND '${endDate}'
//     ORDER BY id DESC
//   `;
// }

async function main() {
	const sessionToken = process.env.METABASE_SESSION_TOKEN;
	if (!sessionToken) {
		console.error("Error: METABASE_SESSION_TOKEN is not set.");
		console.error("Create a .env file or export the variable before running.");
		process.exit(1);
	}

	const { startDate, endDate } = getWeekDateRange();
	console.log(`Week range: ${startDate} to ${endDate}\n`);

	console.log("Fetching database IDs...");
	// const [usDbId, euDbId, globalDbId] = await Promise.all([
	// 	getDatabaseId(sessionToken, US_DB),
	// 	getDatabaseId(sessionToken, EU_DB),
	// 	getDatabaseId(sessionToken, GLOBAL_DB),
	// ]);
	// console.log(
	// 	`US db id=${usDbId}, EU db id=${euDbId}, Global db id=${globalDbId}\n`,
	// );

	const queries = [
		{
			label: "Radar Bug Count (Global)",
			dbId: GLOBAL_DB_ID,
			sql: radarBugSql(startDate, endDate),
		},
		// {
		// 	label: "Radar Bug Count (EU)",
		// 	dbId: euDbId,
		// 	sql: radarBugSql(startDate, endDate),
		// },
		// {
		// 	label: "500 Error Count (US)",
		// 	dbId: usDbId,
		// 	sql: fiveHundredErrorSql(startDate, endDate),
		// },
		// {
		// 	label: "500 Error Count (EU)",
		// 	dbId: euDbId,
		// 	sql: fiveHundredErrorSql(startDate, endDate),
		// },
	];

	console.log(`Running ${queries.length} queries in parallel...`);

	const results = await Promise.all(
		queries.map(({ label, dbId, sql }) =>
			runQuery(sessionToken, dbId, sql)
				.then((result) => ({ label, result, error: null }))
				.catch((err) => ({ label, result: null, error: err.message })),
		),
	);

	console.log("\n========== Weekly Engineering Update ==========\n");
	for (const { label, result, error } of results) {
		console.log(`--- ${label} ---`);
		if (error) {
			console.error(`  Error: ${error}`);
		} else {
			displayResults(result);
		}
		console.log();
	}
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
