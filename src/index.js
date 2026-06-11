require("dotenv").config();
const { runQuery } = require("./metabase");

const GLOBAL_DB_ID = 172;
const US_DB_ID = 2;
const EU_DB_ID = 105;

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

function mysqlAndClickhousePerformanceSql(startDate, endDate) {
	return `
    WITH base AS (
      SELECT
        p.id,
        p.created_at,
        p.queries
      FROM akira_xa3.performance_log p
      WHERE p.source_environment = 'qpprod'
        AND p.created_at BETWEEN '${startDate}' AND '${endDate}'
    ),

    expanded AS (
      SELECT
        b.id,
        b.created_at,
        q.databaseType,
        CASE
          WHEN q.timeTaken IS NULL OR TRIM(q.timeTaken) = '' THEN NULL
          ELSE CAST(q.timeTaken AS UNSIGNED)
        END AS timeTaken_ms
      FROM base b
      JOIN JSON_TABLE(
        CAST(b.queries AS JSON),
        '$[*]' COLUMNS (
          timeTaken VARCHAR(50) PATH '$.timeTaken',
          databaseType VARCHAR(20) PATH '$.databaseType'
        )
      ) q
    )

    SELECT
      /* ================================
        TOTAL COUNTS
      ================================= */
      (
        SELECT SUM(JSON_LENGTH(CAST(queries AS JSON)))
        FROM base
      ) AS totalQueryCount_claimed,

      COUNT(*) AS total_expanded_rows,

      /* ================================
        OVERALL BUCKETS (ms)
      ================================= */
      SUM(timeTaken_ms < 50) AS all_lt_50ms,
      SUM(timeTaken_ms BETWEEN 50 AND 100) AS all_50_100ms,
      SUM(timeTaken_ms BETWEEN 101 AND 200) AS all_101_200ms,
      SUM(timeTaken_ms > 200) AS all_gt_200ms,

      /* ================================
        MYSQL BUCKETS
      ================================= */
      SUM(databaseType = 'MYSQL' AND timeTaken_ms < 50) AS mysql_lt_50ms,
      SUM(databaseType = 'MYSQL' AND timeTaken_ms BETWEEN 50 AND 100) AS mysql_50_100ms,
      SUM(databaseType = 'MYSQL' AND timeTaken_ms BETWEEN 101 AND 200) AS mysql_101_200ms,
      SUM(databaseType = 'MYSQL' AND timeTaken_ms BETWEEN 201 AND 500) AS mysql_201_500ms,
      SUM(databaseType = 'MYSQL' AND timeTaken_ms BETWEEN 501 AND 1000) AS mysql_501_1000ms,
      SUM(databaseType = 'MYSQL' AND timeTaken_ms > 1001) AS mysql_gt_1000ms,
      SUM(databaseType = 'MYSQL') AS mysql_total,

      /* ================================
        CLICKHOUSE BUCKETS
      ================================= */
      SUM(databaseType = 'CLICKHOUSE' AND timeTaken_ms < 50) AS click_lt_50ms,
      SUM(databaseType = 'CLICKHOUSE' AND timeTaken_ms BETWEEN 50 AND 100) AS click_50_100ms,
      SUM(databaseType = 'CLICKHOUSE' AND timeTaken_ms BETWEEN 101 AND 200) AS click_101_200ms,
      SUM(databaseType = 'CLICKHOUSE' AND timeTaken_ms BETWEEN 201 and 500) AS click_200_500ms,
      SUM(databaseType = 'CLICKHOUSE' AND timeTaken_ms BETWEEN 501 and 1000)  AS click_500_1000ms,
      SUM(databaseType = 'CLICKHOUSE' AND timeTaken_ms > 1000) AS click_gt_10s,
      SUM(databaseType = 'CLICKHOUSE') AS click_total,

      /* ================================
        NULL / MISSING
      ================================= */
      SUM(timeTaken_ms IS NULL) AS missing_timeTaken,
      SUM(databaseType IS NULL) AS missing_databaseType

    FROM expanded;
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
		{
			key: "performance",
			dbId: US_DB_ID,
			sql: mysqlAndClickhousePerformanceSql(startDate, endDate),
		},
	];

	console.log(`Running ${queries.length} queries in parallel...\n`);

	const rawResults = await Promise.all(
		queries.map(({ key, dbId, sql }) => {
			const start = Date.now();
			return runQuery(sessionToken, dbId, sql)
				.then((result) => ({ key, result, error: null, elapsed: ((Date.now() - start) / 1000).toFixed(1) }))
				.catch((err) => ({ key, result: null, error: err.message, elapsed: ((Date.now() - start) / 1000).toFixed(1) }));
		}),
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

	const fmtNum = (n) => Number(n ?? 0).toLocaleString("en-US");
	const pct = (n, total) =>
		total > 0 ? ((n / total) * 100).toFixed(4) + "%" : "0.0000%";

	const groupByMessage = (messages) => {
		const counts = new Map();
		messages.forEach((m) => {
			const key = m ?? "N/A";
			counts.set(key, (counts.get(key) || 0) + 1);
		});
		return Array.from(counts.entries());
	};

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
		line(`Radar Bug Count: ${subjects.length} (${radarBugs.elapsed}s)`);
		blank();
		subjects.forEach((s) => line(s ?? "N/A"));
	}

	blank();

	// 500 errors
	const errUs = byKey.errors500Us;
	const errEu = byKey.errors500Eu;
	const usMessages = errUs.error ? [] : colValues(errUs.result, "message");
	const euMessages = errEu.error ? [] : colValues(errEu.result, "message");
	const usCount = errUs.error ? "ERR" : usMessages.length;
	const euCount = errEu.error ? "ERR" : euMessages.length;

	line(`500 Errors: ${usCount} (US) ${euCount} (EU) (${errUs.elapsed}s / ${errEu.elapsed}s)`);
	blank();
	if (errUs.error) line(`US error: ${errUs.error}`);
	else groupByMessage(usMessages).forEach(([msg, count]) => line(`${count} : ${msg}`));
	if (errEu.error) line(`EU error: ${errEu.error}`);
	else groupByMessage(euMessages).forEach(([msg, count]) => line(`${count} : ${msg}`));

	blank();

	// Query performance
	const perf = byKey.performance;
	line(`3. Query Performance Breakdown (${perf.elapsed}s)`);
	line("   a. MySQL Query Performance");
	blank();
	if (perf.error) {
		line(`Performance error: ${perf.error}`);
	} else {
		const val = (col) => colValues(perf.result, col)[0] ?? 0;
		const total = val("mysql_total");
		line(`Total Queries: ${fmtNum(total)}`);
		line(`50 – 100 ms:    ${fmtNum(val("mysql_50_100ms"))} (${pct(val("mysql_50_100ms"), total)})`);
		line(`100 – 200 ms:   ${fmtNum(val("mysql_101_200ms"))} (${pct(val("mysql_101_200ms"), total)})`);
		line(`200 – 500 ms:   ${fmtNum(val("mysql_201_500ms"))} (${pct(val("mysql_201_500ms"), total)})`);
		line(`500 – 1000 ms:  ${fmtNum(val("mysql_501_1000ms"))} (${pct(val("mysql_501_1000ms"), total)})`);
		line(`> 1000 ms:      ${fmtNum(val("mysql_gt_1000ms"))} (${pct(val("mysql_gt_1000ms"), total)})`);
	}

	console.log(lines.join("\n"));
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
