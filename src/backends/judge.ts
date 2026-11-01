/**
 * Judge backend: a model trained to judge a criterion with yes or no, served by llama-server.
 *
 * `format` picks the model family and its trained prompt:
 *
 * - "guardian": IBM Granite Guardian 4.1, with a bring-your-own criterion in no-think mode. It
 *   answers `<score>yes</score>` or `<score>no</score>` straight away.
 * - "selene": Atla Selene 1 Mini, with its binary classification template. It writes
 *   `**Reasoning:** ...` and then `**Result:** Yes` or `No`; the reasoning becomes the summary.
 *
 * Like the tiny backend it is a classifier. A bool check is one criterion, "the answer to the
 * question is yes", and its P(yes) is the answer. A choice or score check is one criterion per
 * option, and the options' P(yes), normalised, become `answer_probs`, so confidence is the
 * probability of the verdict. P(yes) is read from the token probabilities at the judgement. The data
 * comes first in each prompt, so llama-server reuses it from its prompt cache for every option of a
 * check. The server is started and checked as for the local backend.
 */
import type { Check } from "../checks.ts";
import type { Table } from "../config.ts";
import type { Entry } from "../prompt.ts";
import { pyRepr } from "../text.ts";
import { BackendError } from "./base.ts";
import { LocalBackend, TOP_LOGPROBS } from "./local.ts";

export const RECOMMENDED_MODELS: Record<string, string> = {
	guardian: "ibm-granite/granite-guardian-4.1-8b-GGUF:Q4_K_M",
	selene: "AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF",
};
export const FORMATS = Object.keys(RECOMMENDED_MODELS);

// From the Granite Guardian 4.1 model card.
const GUARDIAN_NOTHINK =
	"<no-think>As a judge agent, assess whether the provided text meets the given " +
	"judging criteria using all available information, including conversations, " +
	"documents, and tools. Provide your score immediately without explanation. " +
	"Output empty <think>\\n</think> tags followed by your score in <score></score> tags.";
// The commits go in as the assistant's response: Guardian is mostly trained to judge responses, and
// on a sample of the bench cases it judged them better this way than as the user's text.
const GUARDIAN_SCHEMA = "If the last assistant's text meets the criteria, return 'yes'; otherwise, return 'no'.";
const DATA_INTRO = "Make git commits for your change. Reviewers will see the combined diff and each commit's message.";

// Atla's binary classification training template (github.com/atla-ai/selene-mini).
const SELENE_TEMPLATE = `You are tasked with evaluating a response based on a given user input and binary scoring \
rubric that serves as the evaluation standard. Provide comprehensive feedback on the response quality strictly \
adhering to the scoring rubric, followed by a binary Yes/No judgment. Avoid generating any additional opening, \
closing, or explanations.

Here are some rules of the evaluation:
(1) You should prioritize evaluating whether the response satisfies the provided rubric. The basis of your score \
should depend exactly on the rubric. However, the response does not need to explicitly address points raised in \
the rubric. Rather, evaluate the response based on the criteria outlined in the rubric.

Your reply must strictly follow this format:
**Reasoning:** <Your feedback>

**Result:** <Yes or No>

Here is the data:

Instruction:
\`\`\`
{user_input}
\`\`\`

Response:
\`\`\`
{assistant_response}
\`\`\`

Score Rubrics:
[{rubric_objective}]
Yes: The statement is true of these commits.
No: The statement is false of these commits.`;

/** Per format: the text after which the judgement token comes, and the tokens to generate. */
const FORMAT: Record<string, [marker: string, maxTokens: number]> = {
	guardian: ["<score>", 32],
	selene: ["**Result:**", 1024],
};

type OptionValue = string | number | null;

/** `[answer value, criterion]`: one criterion for a bool check, one per option otherwise. */
export function criteria(check: Check): [OptionValue, string][] {
	const q = `Question about the commits: ${check.instructions}\nCriterion: the correct answer to the question is`;
	if (check.questionType === "bool") return [[null, `${q} yes.`]];
	if (check.questionType === "choice") {
		return Object.entries(check.labels).map(([label, desc]) => [label, `${q} "${label}" (${desc}).`]);
	}
	return check.levels.map((desc, i) => [i, `${q} level ${i} (${desc}).`]);
}

/** P(yes) at the first word after `marker`, from the token probabilities, and the text before it. */
export function pYes(raw: string, marker: string): [number, string] {
	let tokens: { token: string; logprob: number; top_logprobs?: { token: string; logprob: number }[] }[];
	try {
		tokens = JSON.parse(raw).choices[0].logprobs.content;
		if (!Array.isArray(tokens)) throw new TypeError("no tokens");
	} catch {
		throw new BackendError("judge server returned no token probabilities", true);
	}
	let text = "";
	for (const tok of tokens) {
		if (text.includes(marker) && tok.token.trim()) {
			let yes = 0;
			let no = 0;
			const seen = new Set<string>();
			for (const alt of [tok, ...(tok.top_logprobs ?? [])]) {
				const word = alt.token.trim().toLowerCase();
				if (seen.has(alt.token)) continue;
				seen.add(alt.token);
				if (word === "yes") yes += Math.exp(alt.logprob);
				else if (word === "no") no += Math.exp(alt.logprob);
			}
			if (yes + no === 0) break;
			return [yes / (yes + no), reasoning(text.slice(0, text.indexOf(marker)))];
		}
		text += tok.token;
	}
	const why = text.includes(marker) ? "no yes/no judgement" : `no ${pyRepr(marker)} in the answer`;
	throw new BackendError(`judge model gave ${why}`, true);
}

/** The judge's reasoning before its judgement, without think tags or Selene's label. */
export function reasoning(text: string): string {
	const cleaned = text.replace(/<\/?think>|<\/?score>/g, "").replaceAll("**Reasoning:**", "");
	return cleaned.split(/\s+/).filter(Boolean).join(" ");
}

function round4(x: number): number {
	return Math.round(x * 1e4) / 1e4;
}

export class JudgeBackend extends LocalBackend {
	override name = "judge";
	format: string;

	constructor(settings: Table) {
		const format: string = settings.format ?? "guardian";
		if (!FORMATS.includes(format)) {
			throw new BackendError(`backends.judge.format must be one of ${FORMATS.join(", ")}, not ${pyRepr(format)}`);
		}
		super({ device: "gpu", model: RECOMMENDED_MODELS[format], ...settings });
		this.format = format;
	}

	/** Only an empty request (acc doctor's test call) comes here; checks go through `decide`. */
	override async ask(_system: string, _prompt: string, _stdin: string, schema: Table, timeoutSeconds: number): Promise<Table> {
		const props = schema.properties.checks.properties;
		if (props && Object.keys(props).length) {
			throw new BackendError("the judge backend answers checks through decide(), not a JSON prompt");
		}
		await this.ensureServer();
		pYes(await this.post(this.requestFor("data", "The data is not empty."), timeoutSeconds), FORMAT[this.format][0]);
		return { checks: {} };
	}

	messages(stdin: string, criterion: string): Table[] {
		if (this.format === "guardian") {
			const block = `${GUARDIAN_NOTHINK}\n\n### Criteria: ${criterion}\n\n### Scoring Schema: ${GUARDIAN_SCHEMA}`;
			return [
				{ role: "user", content: DATA_INTRO },
				{ role: "assistant", content: stdin },
				{ role: "user", content: block },
			];
		}
		const content = SELENE_TEMPLATE.replace("{user_input}", () => DATA_INTRO)
			.replace("{assistant_response}", () => stdin)
			.replace("{rubric_objective}", () => criterion);
		return [{ role: "user", content }];
	}

	requestFor(stdin: string, criterion: string): Table {
		return {
			model: this.model,
			messages: this.messages(stdin, criterion),
			temperature: 0,
			max_tokens: FORMAT[this.format][1],
			logprobs: true,
			top_logprobs: TOP_LOGPROBS,
		};
	}

	async decide(entries: Entry[], stdin: string, timeoutSeconds: number): Promise<Table> {
		await this.ensureServer();
		const marker = FORMAT[this.format][0];
		const out: Table = {};
		for (const e of entries) {
			const c = e.check;
			const judged: [OptionValue, number, string][] = [];
			for (const [value, crit] of criteria(c)) {
				judged.push([value, ...pYes(await this.post(this.requestFor(stdin, crit), timeoutSeconds), marker)]);
			}
			const reasons = judged.map(([, , r]) => r).filter(Boolean);
			if (c.questionType === "bool") {
				const p = judged[0][1];
				const reason = reasons[0] ?? "";
				out[e.key] = {
					answer: round4(p),
					confidence: round4(Math.max(p, 1 - p)),
					findings: [],
					summary: reason || `P(yes) = ${p.toFixed(2)} (${this.model})`,
				};
				continue;
			}
			const total = judged.reduce((s, [, p]) => s + p, 0) || 1;
			const probs = judged.map(([v, p]) => [v, p / total] as const);
			let best = probs[0];
			for (const entry of probs) if (entry[1] > best[1]) best = entry;
			const listed = probs.map(([v, p]) => `${v} ${p.toFixed(2)}`).join(", ");
			const bestReason = judged.find(([v, , r]) => v === best[0] && r)?.[2] ?? "";
			out[e.key] = {
				answer: best[0],
				confidence: round4(best[1]),
				findings: [],
				answer_probs: probs.map(([v, p]) => [v, round4(p)]),
				summary: `${listed} (${this.model})${bestReason ? `: ${bestReason}` : ""}`,
			};
		}
		return { checks: out };
	}
}
