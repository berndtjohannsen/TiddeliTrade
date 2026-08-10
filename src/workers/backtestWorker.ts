/**
 * Worker thread: runs backtest in isolation. Crashes here won't kill the main process.
 */
import { parentPort, workerData } from 'worker_threads';
import { runBacktestPerDay, runBacktestCarryOver, type BacktestConfig, type BacktestProgressCallback } from '../services/rulesBacktest';
import type { RecordedSample } from '../services/priceRecorder';

interface WorkerInput {
  samples: RecordedSample[];
  config: BacktestConfig;
  usePerDay: boolean;
}

function main(): void {
  const { samples, config, usePerDay } = workerData as WorkerInput;
  const onSampleProgress: BacktestProgressCallback = (processed, total, stats) => {
    parentPort!.postMessage({
      progress: {
        processed,
        total,
        scope: 'samples',
        totalGainLoss: stats?.totalGainLoss,
        winningTrades: stats?.winningTrades,
        losingTrades: stats?.losingTrades,
        tradeCount: stats?.tradeCount,
      },
    });
  };
  try {
    const report = usePerDay
      ? runBacktestPerDay(samples, config, (processed, total) => {
          parentPort!.postMessage({ progress: { processed, total, scope: 'days' } });
        })
      : runBacktestCarryOver(samples, config, undefined, onSampleProgress);
    parentPort!.postMessage({ report });
  } catch (err) {
    parentPort!.postMessage({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

main();
