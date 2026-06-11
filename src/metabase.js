const axios = require("axios");

const METABASE_URL = "https://metabase.questionpro.net";

function client(sessionToken) {
	return axios.create({
		baseURL: METABASE_URL,
		headers: { "X-Metabase-Session": sessionToken },
		timeout: 15 * 60 * 1000, // 15 minutes for long-running queries
	});
}

async function getDatabaseId(sessionToken, dbName) {
	const { data } = await client(sessionToken).get("/api/database");
	const databases = data.data ?? data;
	const db = databases.find(
		(d) => d.name.toLowerCase() === dbName.toLowerCase(),
	);
	if (!db) {
		const names = databases.map((d) => d.name).join(", ");
		throw new Error(`Database "${dbName}" not found. Available: ${names}`);
	}
	return db.id;
}

async function runQuery(sessionToken, databaseId, sql) {
	// console.log("sql", sql);
	const { data } = await client(sessionToken).post("/api/dataset", {
		database: databaseId,
		type: "native",
		native: { query: sql },
	});
	if (data.error) throw new Error(`Query error: ${data.error}`);
	return data;
}

module.exports = { getDatabaseId, runQuery };
