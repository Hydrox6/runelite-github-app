import { Application, ProbotOctokit } from "probot";
import { OctokitResponse, PullsListFilesResponseData } from "@octokit/types";
type Octokit = InstanceType<typeof ProbotOctokit>;

const PLUGIN_CHANGE = "plugin change";
const PACKAGE_CHANGE = "package change";
const DEPENDENCY_CHANGE = "dependency change";
const READY_TO_MERGE = "ready to merge";

const TEAM = {
	org: "runelite",
	team_slug: "plugin-approvers",
};

// If you run the app outside of an org it can't get to the org's teams
let globalTeamGithub : Octokit | undefined;
if (process.env.TEAM_TOKEN) {
	globalTeamGithub = new ProbotOctokit({auth: {token: process.env.TEAM_TOKEN}});
}

export = (app: Application) => {
	app.on(['pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened'], async context => {
		const github = context.github;

		let { data: labelList } = await github.issues.listLabelsOnIssue(context.issue());
		let labels = new Set(labelList.map(l => l.name));

		const setHasLabel = async (condition: boolean, label: string) => {
			if (condition && !labels.has(label)) {
				await github.issues.addLabels(context.issue({ labels: [label] }));
			} else if (!condition && labels.has(label)) {
				await github.issues.removeLabel(context.issue({ name: label }));
			}
		};

		await setHasLabel(false, READY_TO_MERGE);

		let pluginFiles: PullsListFilesResponseData = [];
		let dependencyFiles: PullsListFilesResponseData = [];
		let otherFiles: PullsListFilesResponseData = [];
		(await github.pulls.listFiles(context.pullRequest()))
			.data
			.forEach(f => {
				if (f.filename.startsWith("plugins/")) {
					pluginFiles.push(f);
				} else if (f.filename == "package/verification-template/build.gradle"
					|| f.filename == "package/verification-template/gradle/verification-metadata.xml") {
						dependencyFiles.push(f);
				} else {
					otherFiles.push(f);
				}
			});

		await setHasLabel(pluginFiles.length > 0, PLUGIN_CHANGE);
		await setHasLabel(dependencyFiles.length > 0, DEPENDENCY_CHANGE);
		await setHasLabel(otherFiles.length > 0, PACKAGE_CHANGE);

		let difftext = (await Promise.all(pluginFiles.map(async file => {
			let pluginName = file.filename.replace("plugins/", "");
			if (file.status == "removed") {
				return `Removed \`${pluginName}\` plugin`;
			}
			let readKV = (res: OctokitResponse<string>) => res.data.split("\n")
				.map(i => /([^=]+)=(.*)/.exec(i))
				.filter(i => i)
				.reduce((acc: { [key: string]: string }, val) => {
					acc[val![1]] = val![2];
					return acc;
				}, {});
			let newPlugin = readKV(await github.request(file.raw_url));

			let extractURL = (cloneURL: string) => {
				let urlmatch = /https:\/\/github\.com\/([^/]+)\/([^.]+).git/.exec(cloneURL);
				if (!urlmatch) {
					throw `Plugin repository must be a github https clone url, not \`${cloneURL}\``;
				}
				let [, user, repo] = urlmatch;
				return { user, repo };
			};
			let { user, repo } = extractURL(newPlugin.repository);

			if (file.status == "modified") {
				let oldPlugin = readKV(await github.request(`https://github.com/${context.repo().owner}/${context.repo().repo}/raw/master/plugins/${pluginName}`));
				let oldPluginURL = extractURL(oldPlugin.repository);
				return `\`${pluginName}\`: [${oldPlugin.commit}...${newPlugin.commit}](https://github.com/${oldPluginURL.user}/${oldPluginURL.repo}/compare/${oldPlugin.commit}...${user}:${newPlugin.commit})`;
			} else if (file.status == "added") {
				return `New plugin \`${pluginName}\`: https://github.com/${user}/${repo}/tree/${newPlugin.commit}`;
			} else if (file.status == "renamed") {
				let oldPluginName = ((file as any).previous_filename as string).replace("plugins/", "");
				let oldPlugin = readKV(await github.request(`https://github.com/${context.repo().owner}/${context.repo().repo}/raw/master/plugins/${oldPluginName}`));
				let oldPluginURL = extractURL(oldPlugin.repository);
				return `\`${oldPluginName}\` renamed to \`${pluginName}\`; this will cause all current installs to become uninstalled.
[${oldPlugin.commit}...${newPlugin.commit}](https://github.com/${oldPluginURL.user}/${oldPluginURL.repo}/compare/${oldPlugin.commit}...${user}:${newPlugin.commit})`;
			} else {
				return `What is a \`${file.status}\`?`;
			}
		}))).join("\n\n");

		if (dependencyFiles.length > 0 || otherFiles.length > 0) {
			difftext = "**Includes non-plugin changes**\n\n" + difftext;
		}

		let marker = "<!-- rlphc -->";
		let body = marker + "\n" + difftext;
		let sticky = (await github.issues.listComments(context.issue()))
			.data.find(c => c.body.startsWith(marker));
		if (sticky) {
			await github.issues.updateComment(context.issue({ comment_id: sticky.id, body }));
		} else if (difftext) {
			await github.issues.createComment(context.issue({ body }));
		}
	});

	app.on(["pull_request_review.submitted"], async context => {
		const github = context.github;
		const teamGithub = globalTeamGithub || github;

		let { data: labelList } = await github.issues.listLabelsOnIssue(context.issue());
		let labels = new Set(labelList.map(l => l.name));

		if (!labels.has(PLUGIN_CHANGE)) return;

		let { data: reviews } = await github.pulls.listReviews(context.pullRequest());
		if (reviews.length <= 0) return;

		let { data: memberList } = await teamGithub.teams.listMembersInOrg(TEAM);
		let members = new Set(memberList.map(m => m.login));

		let reviewStates: { [key: string]: boolean } = {};
		reviews.filter(r => members.has(r.user.login))
			.forEach(r => {
				let approved = r.state == "APPROVED" || r.body == "lgtm";
				if (approved || (!approved && r.state != "COMMENTED")) {
					reviewStates[r.user.login] = approved;
				}
			});
		let unapproved = Object.keys(reviewStates).filter(k => !reviewStates[k]);

		if (unapproved.length > 0) {
			console.log(`Unapproved for #${context.issue().issue_number}: ${unapproved}`);
			if (labels.has(READY_TO_MERGE)) {
				await github.issues.removeLabel(context.issue({ name: READY_TO_MERGE }));
			}
		} else if (Object.keys(reviewStates).length != 0) {
			if (!labels.has(READY_TO_MERGE)) {
				await github.issues.addLabels(context.issue({ labels: [READY_TO_MERGE] }));
			}
		}
	});
}
