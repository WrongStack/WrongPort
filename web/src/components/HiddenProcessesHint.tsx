interface HiddenProcessesHintProps {
  /** scannedCount - selected count; zero or negative renders nothing. */
  hiddenCount: number;
}

/**
 * Under-table hint telling the user how many listening processes the dev
 * filter is currently hiding, and how to reveal them.
 */
export function HiddenProcessesHint({ hiddenCount }: HiddenProcessesHintProps) {
  if (hiddenCount <= 0) return null;
  return (
    <p className="mt-3 font-mono text-xs text-muted">
      {hiddenCount} more listening process(es) hidden by the dev filter — enable "all
      processes" or add a filter chip to reveal them.
    </p>
  );
}
