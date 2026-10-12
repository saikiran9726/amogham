import React, { useState } from 'react';
import { localDb } from '../../db/dexie.js';

const PREVIOUSLY_CONFIRMED_ORDER_ID = '01a1291e-d8fb-7000-8994-2d6072cd4e3c';

interface DiagnosticCommand {
  type: 'order.create' | 'kot.send';
  status: string;
  attempts: number;
  orderId: string;
}

interface WaiterCartOutboxDiagnosticsProps {
  cartOrderId: string;
}

export const WaiterCartOutboxDiagnostics: React.FC<WaiterCartOutboxDiagnosticsProps> = ({
  cartOrderId,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [commands, setCommands] = useState<DiagnosticCommand[]>([]);
  const [readError, setReadError] = useState(false);

  if (!import.meta.env.DEV) return null;

  const readOutbox = async () => {
    setIsReading(true);
    setReadError(false);
    try {
      const relevantOrderIds = new Set([cartOrderId, PREVIOUSLY_CONFIRMED_ORDER_ID]);
      const matchingCommands = await localDb.transaction('r', localDb.outbox, async () => {
        const rows = await localDb.outbox.toArray();
        const matches: DiagnosticCommand[] = [];
        for (const row of rows) {
          if (
            row.type === 'order.create' &&
            typeof row.payload?.id === 'string' &&
            relevantOrderIds.has(row.payload.id)
          ) {
            matches.push({
              type: 'order.create' as const,
              status: row.status,
              attempts: row.attempts,
              orderId: row.payload.id,
            });
          }
          if (
            row.type === 'kot.send' &&
            typeof row.payload?.orderId === 'string' &&
            relevantOrderIds.has(row.payload.orderId)
          ) {
            matches.push({
              type: 'kot.send' as const,
              status: row.status,
              attempts: row.attempts,
              orderId: row.payload.orderId,
            });
          }
        }
        return matches;
      });
      setCommands(matchingCommands);
    } catch {
      setReadError(true);
      setCommands([]);
    } finally {
      setIsReading(false);
    }
  };

  const openDiagnostics = () => {
    setIsOpen((open) => !open);
    if (!isOpen) void readOutbox();
  };

  return (
    <section className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
      <button
        type="button"
        onClick={openDiagnostics}
        aria-expanded={isOpen}
        className="font-semibold text-content-secondary underline underline-offset-2"
      >
        {isOpen ? 'Hide' : 'Show'} temporary cart/outbox diagnostics (development only)
      </button>

      {isOpen && (
        <div className="mt-2 space-y-2 break-all text-content-secondary">
          <p>
            Cart order ID: <code>{cartOrderId}</code>
          </p>
          <p>
            Matches previously confirmed order:{' '}
            <strong>{cartOrderId === PREVIOUSLY_CONFIRMED_ORDER_ID ? 'Yes' : 'No'}</strong>
          </p>
          <div className="flex items-center gap-2">
            <span className="font-semibold">Matching outbox commands</span>
            <button
              type="button"
              onClick={() => void readOutbox()}
              disabled={isReading}
              className="underline underline-offset-2 disabled:opacity-50"
            >
              {isReading ? 'Reading…' : 'Refresh read-only snapshot'}
            </button>
          </div>
          <p className="text-content-muted">
            Reads the cart store and IndexedDB only; it does not sync or change records.
          </p>
          {readError ? (
            <p role="alert">Could not read the local outbox.</p>
          ) : commands.length > 0 ? (
            <ul className="space-y-1">
              {commands.map((command, index) => (
                <li key={`${command.type}-${command.orderId}-${index}`}>
                  <code>{command.type}</code> for <code>{command.orderId}</code> — status:{' '}
                  <strong>{command.status}</strong>, attempts: <strong>{command.attempts}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p>No matching order.create or kot.send commands found.</p>
          )}
        </div>
      )}
    </section>
  );
};
