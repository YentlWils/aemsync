/*global console, require, process, setInterval, Buffer, __dirname */
(function () {
	"use strict";

	var os = require("os");
	var fs = require("fs");
	var path = require('path');
	var parseUrl = require('url').parse;
	var watch = require("node-watch");
	var minimist = require('minimist');
	var AdmZip = require("adm-zip");
	var FormData = require('form-data');

	var HELP = "Usage: aemsync -t targets [-i interval] path_to_watch\nWebsite: https://github.com/gavoja/aemsync";

	var syncerInterval = 500;
	var queue = [];
	var lock = 0;

	function Syncer(targets, queue) {
		targets = targets.split(",");

		var sendForm = function(zipPath) {
			for (var i=0; i<targets.length; ++i) {
				var params = parseUrl(targets[i]);
				var options = {};
				options.path = "/crx/packmgr/service.jsp";
				options.port = params.port;
				options.host = params.hostname;
				options.headers = {"Authorization":"Basic " + new Buffer(params.auth).toString('base64')};

				var form = new FormData();
				form.append('file', fs.createReadStream(zipPath));
				form.append('name', 'aemsync');
				form.append('force', 'true');
				form.append('install', 'true');
				form.submit(options, formSubmitCallback);
			}
		};

		var formSubmitCallback = function(err, res) {
			var msg = res ? "  " + res.req._headers.host + " -> " + res.statusCode : "  " + this._headers.host + " -> " + err.code;
			console.log(msg);
			lock -= 1;
		};

		var createPackage = function() {
			var zip = new AdmZip();
			zip.addLocalFolder(__dirname + "/package_content");
			return {zip: zip, filters: "" };
		};

		var installPackage = function(pack) {
			// Add filters.
			pack.filters = '<?xml version="1.0" encoding="UTF-8"?>\n<workspaceFilter version="1.0">\nFILTERS</workspaceFilter>'.replace(/FILTERS/g, pack.filters);
			pack.zip.addFile("META-INF/vault/filter.xml", new Buffer(pack.filters));

			// TODO: Make in-memory zip.
			var zipPath = os.tmpdir() + "/aemsync.zip";
			pack.zip.writeZip(zipPath);
			sendForm(zipPath);
		};

		this.process = function() {
			var i, list = [];

			// Lock.
			if (lock > 0 || queue.length === 0) {
				return;
			}
			lock = targets.length;

			// Enqueue items.
			while((i = queue.pop())) {
				list.push(i);
			}

			// Remove duplicates.
			list = list.filter(function(elem, pos, self) {
				return self.indexOf(elem) == pos;
			});

			var pack = createPackage();

			for (i=0; i<list.length; ++i) {
				var localPath = list[i];

				var repoPath = localPath.substring(localPath.indexOf("jcr_root"));
				var filterItem = repoPath.substring(8).replace(/\.xml$/g, "").replace(/\.content$/g, "jcr:content");
				var filterParent = path.dirname(filterItem);
				var zipPath = path.dirname(repoPath);

				// Deletes items from zip.
				if (fs.existsSync(localPath) === false) {
					console.log("Delete: ", repoPath);
					pack.filters += '<filter root="ITEM" />\n'.replace(/ITEM/g, filterItem);

				// Add file to zip if exists.
				} else if (fs.lstatSync(localPath).isFile()) {
					console.log("Update: ", repoPath);
					pack.zip.addLocalFile(localPath, zipPath);
					var filter = '<filter root="PARENT"><exclude pattern="PARENT/.*" /><include pattern="ITEM" /></filter>\n';
					pack.filters += filter.replace(/PARENT/g, filterParent).replace(/ITEM/g, filterItem);
				}

				// TODO: Handle .content.xml deletion.
				// TODO: Handle ".dir" folders.
			}

			installPackage(pack);
		};

		setInterval(this.process, syncerInterval);
	}

	function Watcher(pathToWatch, queue) {
		if (!fs.existsSync(pathToWatch)) {
			console.error("Invalid path: " + pathToWatch);
			return;
		}

		console.log("Watching: " + pathToWatch + ". Update interval: " + syncerInterval + " ms.");
		watch(pathToWatch, function(localPath) {
			// Use slashes only.
			localPath = localPath.replace("/\\/g", "/");

			// Path must contain "jcr_root" and must not be in a hidden folder.
			if (/^((?!\/\.).)*\/jcr_root\/.*$/.test(localPath)) {
				queue.push(localPath);
			}
		});
	}

	function main() {
		var args = minimist(process.argv.slice(2));
		if (!args.t || !args._[0]) {
			console.log(HELP);
			return;
		}
		syncerInterval = args.i || syncerInterval;
		new Watcher(args._[0], queue);
		new Syncer(args.t, queue);
	}

	main();
}());