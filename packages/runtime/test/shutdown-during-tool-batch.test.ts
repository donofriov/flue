import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEASE_DURATION_MS } from '../src/agent-execution-store.ts';
import { AgentRunError, init, useModel, useTool } from '../src/index.ts';
import { type Flue, sqlite, start } from '../src/node/index.ts';

const faux = fauxProvider();
let toolStarted: () => void = () => {};

function ShutdownProbe() {
	useModel('faux/faux-1');
	useTool({
		name: 'slow_lookup',
		description: 'A lookup that runs until its call is aborted.',
		input: v.object({}),
		run: ({ signal }) => {
			toolStarted();
			return new Promise<string>((_, reject) => {
				signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		},
	});
	return 'Call slow_lookup, then answer.';
}

describe('an abort while a tool batch is running', () => {
	let dir: string;
	let flue: Flue | undefined;

	const startFlue = async () => {
		flue = await start({
			agents: [ShutdownProbe],
			db: sqlite(join(dir, 'flue.db')),
			providers: [faux.provider],
		});
	};

	const dispatchUntilToolRuns = async (id: string) => {
		const running = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall('slow_lookup', {}), { stopReason: 'toolUse' }),
		]);
		const agent = init(ShutdownProbe, { id });
		const receipt = await agent.dispatch('Look it up.');
		await running;
		return { agent, receipt };
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'flue-shutdown-'));
		// Only Date is faked, so a restart can land past the previous lease.
		vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
	});

	afterEach(async () => {
		await flue?.stop();
		flue = undefined;
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it('resumes and completes after a graceful shutdown', async () => {
		await startFlue();
		const { receipt } = await dispatchUntilToolRuns('shutdown');

		await flue?.stop();
		vi.setSystemTime(Date.now() + LEASE_DURATION_MS + 1_000);
		faux.setResponses([fauxAssistantMessage('Recovered answer.')]);
		await startFlue();

		const reply = await init(ShutdownProbe, { id: 'shutdown' }).read(receipt);
		expect(reply.text).toBe('Recovered answer.');
	});

	it('settles aborted after a user abort', async () => {
		await startFlue();
		const { agent, receipt } = await dispatchUntilToolRuns('user-abort');

		await agent.abort();

		const error = await agent.read(receipt).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(AgentRunError);
		expect((error as AgentRunError).outcome).toBe('aborted');

		await flue?.stop();
		vi.setSystemTime(Date.now() + LEASE_DURATION_MS + 1_000);
		faux.setResponses([fauxAssistantMessage('Should not run.')]);
		await startFlue();

		const afterRestart = await init(ShutdownProbe, { id: 'user-abort' })
			.read(receipt)
			.catch((caught: unknown) => caught);
		expect((afterRestart as AgentRunError).outcome).toBe('aborted');
		expect(faux.getPendingResponseCount()).toBe(1);
	});
});
