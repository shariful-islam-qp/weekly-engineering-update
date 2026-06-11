const axios = require("axios");

const METABASE_URL = "https://metabase.questionpro.net";

function client(sessionToken) {
	return axios.create({
		baseURL: METABASE_URL,
		headers: { "X-Metabase-Session": sessionToken },
		timeout: 15 * 60 * 1000, // 15 minutes for long-running queries
	});
}

async function runQuery(sessionToken, databaseId, sql, retries = 3) {
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const { data } = await client(sessionToken).post("/api/dataset", {
				database: databaseId,
				type: "native",
				native: { query: sql },
			});
			if (data.error) throw new Error(`Query error: ${data.error}`);
			return data;
		} catch (err) {
			const isSocketError = err.code === "ECONNRESET" || err.message === "socket hang up";
			if (isSocketError && attempt < retries) {
				console.warn(`Attempt ${attempt} failed (socket hang up), retrying...`);
				await new Promise((r) => setTimeout(r, 3000 * attempt));
			} else {
				throw err;
			}
		}
	}
}

module.exports = { runQuery };
