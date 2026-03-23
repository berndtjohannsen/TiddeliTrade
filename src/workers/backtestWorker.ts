/**
 * Worker thread: runs backtest in isolation. Crashes here won't kill the main process.
 */
import { parentPort, workerData } from 'worker_threads';
import { runBacktestPerDay, runBacktestCarryOver, type BacktestConfig } from '../services/rulesBacktest';
import type { RecordedSample } from '../services/priceRecorder';

interface WorkerInput {
  samples: RecordedSample[];
  config: BacktestConfig;
  usePerDay: boolean;
}

function main(): void {
  const { samples, config, usePerDay } = workerData as WorkerInput;
  const onProgress = (processed: number, total: number) => {
    parentPort!.postMessage({ progress: { processed, total } });
  };
  try {
    const report = usePerDay
      ? runBacktestPerDay(samples, config, onProgress)
      : runBacktestCarryOver(samples, config, onProgress);
    parentPort!.postMessage({ report });
  } catch (err) {
    parentPort!.postMessage({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

main();
