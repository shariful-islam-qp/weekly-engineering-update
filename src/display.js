const Table = require("cli-table3");

function displayResults(result) {
	const cols = result.data.cols.map((c) => c.display_name);
	const rows = result.data.rows;

	if (!rows.length) {
		console.log("Query returned no results.");
		return;
	}

	// const table = new Table({ head: cols });
	// rows.forEach((row) => table.push(row));

	console.log(
		`\nResults (${rows.length} row${rows.length !== 1 ? "s" : ""}):\n`,
	);
	// console.log(table.toString());
}

module.exports = { displayResults };
