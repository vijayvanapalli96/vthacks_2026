'use client';

/**
 * DropZone — a real <input type="file"> wearing a plane you can throw a file at.
 *
 * IT IS STILL THE SAME INPUT. The element keeps its `name`, stays in the form, and is
 * never recreated, so `uploadResumeAction` and `linkedInAction` receive exactly the
 * FormData they received before this component existed. A drop writes into
 * `input.files` via a DataTransfer rather than holding the File in React state and
 * re-plumbing the submit — if that write throws (older Safari), nothing is shown as
 * selected, because a plane that says "got it" over an input the server will find empty
 * is the worst outcome available here.
 *
 * THE PLANE IS A <label>, NOT A CLICKABLE DIV. That is what makes the whole surface
 * open the picker with no onClick, no key handler, and nothing for jsx-a11y to object
 * to. It can only be a label while it is EMPTY, though: once a file is chosen the plane
 * grows a Remove button, and a button inside a label fires the label too. So the filled
 * state renders a <div> and moves the click affordance to a small "Replace" label
 * beside it. Two elements, one input, no ambiguity about what a click does.
 *
 * THE INPUT IS CLIPPED, NOT `display: none`. Removing it from the box model would
 * remove it from the tab order, and keyboard users would have no way to reach the
 * picker at all. It sits immediately before the plane so `.drop-input:focus-visible +
 * .drop` can paint the focus ring on the plane the pointer user sees.
 *
 * DRAG DEPTH IS COUNTED. dragenter/dragleave fire for every descendant the cursor
 * crosses, so a boolean flickers as the pointer moves over the headline. The counter is
 * a ref: it is bookkeeping for the DOM's event sequence, not state anything renders.
 */
import { useCallback, useRef, useState } from 'react';

type DropZoneProps = {
  /** Must match the input the server action reads. */
  id: string;
  name: string;
  accept: string;
  /** The field's name in the form's own voice, above the plane. */
  label: string;
  /** What to drop, in the user's words. The largest line until a file is chosen. */
  prompt: string;
  /** The honest constraint — formats and ceiling. */
  constraint: string;
  /** Clean accessible name for the input, so a screen reader hears one short phrase. */
  ariaLabel: string;
  disabled?: boolean;
  invalid?: boolean;
  /** ids of the hint and, when the server blamed this field, the error. */
  describedBy?: string;
  /**
   * A file just landed in the input — dropped or picked, the two are not distinguished.
   * Fires AFTER `input.files` is populated, so a handler may submit the form
   * immediately and find the file there.
   */
  onFileChosen?: (file: File) => void;
  /** The long explanation. Rendered under the plane, where it does not crowd it. */
  children?: React.ReactNode;
};

/** Sizes a person recognises. No middle dots, no bytes past the first kilobyte. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function DropZone({
  id,
  name,
  accept,
  label,
  prompt,
  constraint,
  ariaLabel,
  disabled = false,
  invalid = false,
  describedBy,
  onFileChosen,
  children,
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const depth = useRef(0);
  const [chosen, setChosen] = useState<{ name: string; size: number } | null>(null);
  const [over, setOver] = useState(false);

  const onDragEnter = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      if (disabled) return;
      depth.current += 1;
      setOver(true);
    },
    [disabled],
  );

  // Without preventDefault on dragover the browser navigates to the file instead of
  // letting us have the drop event at all.
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      if (disabled) return;

      const dropped = event.dataTransfer.files?.[0];
      const input = inputRef.current;
      if (!dropped || !input) return;

      try {
        // The only supported way to put a dropped File where a form submit will find
        // it. Assigning a FileList built by hand is deliberate; there is no API to
        // append one File to an existing input.
        const transfer = new DataTransfer();
        transfer.items.add(dropped);
        input.files = transfer.files;
      } catch {
        // The input stays empty, so we must not claim otherwise. The picker below
        // still works and is the fix.
        return;
      }

      setChosen({ name: dropped.name, size: dropped.size });
      onFileChosen?.(dropped);
    },
    [disabled, onFileChosen],
  );

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const picked = event.target.files?.[0];
      setChosen(picked ? { name: picked.name, size: picked.size } : null);
      // Not fired when the picker was cancelled: `files` is empty and nothing changed,
      // so a caller that auto-submits must not be told a file arrived.
      if (picked) onFileChosen?.(picked);
    },
    [onFileChosen],
  );

  const onRemove = useCallback(() => {
    const input = inputRef.current;
    if (input) input.value = '';
    setChosen(null);
  }, []);

  const dragProps = { onDragEnter, onDragOver, onDragLeave, onDrop };
  const planeClass = [
    'drop',
    over ? 'is-over' : '',
    chosen ? 'is-filled' : '',
    invalid ? 'is-invalid' : '',
    disabled ? 'is-disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="drop-field">
      <span className="drop-label">{label}</span>

      <input
        ref={inputRef}
        className="drop-input"
        id={id}
        name={name}
        type="file"
        accept={accept}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={onChange}
      />

      {chosen ? (
        <div className={planeClass} {...dragProps}>
          <p className="drop-headline">{chosen.name}</p>
          <span className="drop-meta">{formatSize(chosen.size)}</span>
          <span className="drop-actions">
            <label className="drop-cue" htmlFor={id}>
              Replace
            </label>
            <button className="drop-remove" type="button" onClick={onRemove} disabled={disabled}>
              Remove
            </button>
          </span>
        </div>
      ) : (
        <label className={planeClass} htmlFor={id} {...dragProps}>
          <p className="drop-headline">{over ? 'Let go to add it.' : prompt}</p>
          <span className="drop-meta">{constraint}</span>
          <span className="drop-cue">Choose a file</span>
        </label>
      )}

      {/* The plane is a label, and a label's changing text is not reliably announced.
          This is how a screen-reader user finds out the drop landed. */}
      <p className="drop-announce" role="status">
        {chosen ? `${chosen.name}, ${formatSize(chosen.size)}, ready to send.` : ''}
      </p>

      {children}
    </div>
  );
}
