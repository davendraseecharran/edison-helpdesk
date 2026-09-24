'use client';

/**
 * The label printer: pick the machines, pick the stock, print.
 *
 * Machines arrive from wherever somebody was — a selection on Devices, one
 * device's page, a finished workflow run — and more are added here by
 * scanning, typing or pasting a column of tags. The stock is what is in the
 * printer: two Avery sheets, two address rolls and a desk thermal. What goes
 * on a label is a Code 128 barcode or a QR code of the tag, the tag in mono,
 * and any of the serial, the model and the property line.
 *
 * The preview is the print. Each page is drawn once, at its real size in
 * millimetres, and the preview scales that drawing to fit the column; the
 * print is the same drawing unscaled, on an `@page` the size of the stock
 * with no margin, so Chrome lays the labels exactly where the die cuts are.
 * On a partly used sheet, pressing the first free label on the preview starts
 * the print there.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Camera, ChevronLeft, ChevronRight, Minus, Plus, Printer, Smartphone, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { showToast } from '@/components/ui/shadcn/sonner';
import { PhonePairing } from '@/components/workflows/PhonePairing';
import { ScanInput } from '@/components/workflows/ScanInput';
import { WorkflowCamera } from '@/components/workflows/WorkflowCamera';
import { labelDevicesByCodesAction } from '@/lib/data/device-check-actions';
import { encodableB, encodeCode128B, totalModules } from '@/lib/labels/code128';
import {
  barcodeReadable,
  clampSkip,
  codesFromPaste,
  codeSource,
  expandCopies,
  LABEL_DEVICE_CAP,
  LABEL_TEMPLATES,
  labelLayout,
  modelLine,
  pageRule,
  pagesNeeded,
  perPage,
  placeLabels,
  templateFor,
  type LabelContent,
  type LabelDevice,
  type LabelLine,
  type LabelSymbol,
  type LabelTemplate,
} from '@/lib/labels/layout';
import {
  labelPrefsSnapshot,
  serverLabelPrefs,
  subscribeLabelPrefs,
  writeLabelPrefs,
  type LabelPrefs,
} from '@/lib/labels/prefs';
import {
  feedback,
  soundPreferenceSnapshot,
  subscribeSoundPreference,
} from '@/lib/workflows/feedback';
import { LabelSheet, type PlacedLabel } from './LabelSheet';
// The scan field and the phone pairing are the workflows' own, styles and all.
import '@/styles/workflows.css';
import '@/styles/labels.css';

const PX_PER_MM = 96 / 25.4;

const LINE_NAMES: Record<LabelLine, string> = {
  tag: 'the tag',
  serial: 'the serial',
  model: 'the model',
  property: 'the property line',
};

function noun(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function subscribeToNothing(): () => void {
  return () => {};
}

/** The document body, once there is one: where the print pages are mounted. */
function useBody(): HTMLElement | null {
  return useSyncExternalStore(
    subscribeToNothing,
    () => document.body,
    () => null,
  );
}

/** A page drawn at full size, scaled to the width it is given. */
function Scaled({
  width,
  height,
  maxScale = 1,
  children,
}: {
  width: number;
  height: number;
  maxScale?: number;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | null>(null);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const pageWidth = width * PX_PER_MM;
  const scale = available === null ? null : Math.min(maxScale, available / pageWidth);
  const style: CSSProperties = {
    height: scale === null ? undefined : `${height * PX_PER_MM * scale}px`,
    visibility: scale === null ? 'hidden' : undefined,
  };
  return (
    <div ref={frame} className="lp-scaled" style={style}>
      <div className="lp-scaled-inner" style={{ transform: `scale(${scale ?? 1})` }}>
        {children}
      </div>
    </div>
  );
}

export function LabelPrinter({ initial }: { initial: LabelDevice[] }) {
  const prefs = useSyncExternalStore(subscribeLabelPrefs, labelPrefsSnapshot, serverLabelPrefs);
  const sound = useSyncExternalStore(subscribeSoundPreference, soundPreferenceSnapshot, () => true);
  const body = useBody();
  const [devices, setDevices] = useState<LabelDevice[]>(initial);
  const [skip, setSkip] = useState(0);
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(0);
  const [missed, setMissed] = useState<{ unknown: string[]; ambiguous: string[] }>({ unknown: [], ambiguous: [] });
  const [camera, setCamera] = useState(false);
  const [pairing, setPairing] = useState(false);
  const devicesRef = useRef(devices);
  useEffect(() => {
    devicesRef.current = devices;
  }, [devices]);

  const template = templateFor(prefs.template);
  const content = prefs.content;
  const copies = prefs.copies;
  const startAt = clampSkip(template, skip);

  const update = useCallback((patch: Partial<LabelPrefs>) => {
    writeLabelPrefs({ ...labelPrefsSnapshot(), ...patch });
  }, []);

  const layout = useMemo(() => labelLayout(template, content), [template, content]);
  const printed = useMemo(() => expandCopies(devices, copies), [devices, copies]);
  const placed = useMemo<PlacedLabel[]>(() => {
    const slots = placeLabels(template, printed.length, startAt);
    return slots.map((slot, index) => ({ slot, device: printed[index], key: `${printed[index].id}-${index}` }));
  }, [template, printed, startAt]);
  const pages = pagesNeeded(template, printed.length, startAt);
  const byPage = useMemo(() => {
    const grouped: PlacedLabel[][] = Array.from({ length: pages }, () => []);
    for (const label of placed) grouped[label.slot.page]?.push(label);
    return grouped;
  }, [placed, pages]);
  const shownPage = Math.min(page, Math.max(0, pages - 1));

  // What will not come out right, said beside the preview rather than found on paper.
  const warnings = useMemo(() => {
    const list: string[] = [];
    if (content.symbol === 'barcode') {
      const unwritable = devices.filter((device) => !encodableB(device.code));
      if (unwritable.length > 0) {
        list.push(
          `${unwritable.map((device) => device.code).slice(0, 3).join(', ')} cannot be written as a barcode. Use QR.`,
        );
      }
      const thin = devices.filter(
        (device) =>
          encodableB(device.code) && !barcodeReadable(layout.symbol.width, totalModules(encodeCode128B(device.code))),
      );
      if (thin.length > 0) {
        list.push(
          `${noun(thin.length, 'tag is', 'tags are')} too long for bars this narrow. Use QR, or a wider label.`,
        );
      }
    }
    if (layout.dropped.length > 0) {
      list.push(`No room on this label for ${layout.dropped.map((line) => LINE_NAMES[line]).join(' or ')}.`);
    }
    return list;
  }, [devices, content.symbol, layout]);

  const add = useCallback(
    async (codes: string[]) => {
      const current = devicesRef.current;
      const known = new Set(
        current.flatMap((device) => [device.code, device.assetTag, device.serialNumber].map((code) => code.toUpperCase())),
      );
      const fresh = codes.filter((code) => !known.has(code.trim().toUpperCase()));
      if (fresh.length === 0) {
        feedback('skipped', sound);
        return;
      }
      const room = LABEL_DEVICE_CAP - current.length;
      if (room <= 0) {
        showToast('error', `${LABEL_DEVICE_CAP} machines is the most one print takes. Print these first.`);
        return;
      }
      setAdding((count) => count + 1);
      try {
        const result = await labelDevicesByCodesAction(fresh.slice(0, room));
        setDevices((was) => {
          const ids = new Set(was.map((device) => device.id));
          return [...was, ...result.found.filter((device) => !ids.has(device.id))];
        });
        setMissed((was) => ({
          unknown: [...new Set([...was.unknown, ...result.unknown])].slice(-12),
          ambiguous: [...new Set([...was.ambiguous, ...result.ambiguous])].slice(-12),
        }));
        feedback(result.found.length > 0 ? 'done' : 'error', sound);
      } catch {
        showToast('error', 'That did not reach the helpdesk. Nothing was added. Try again.');
        feedback('error', sound);
      } finally {
        setAdding((count) => count - 1);
      }
    },
    [sound],
  );

  const onCode = useCallback((code: string) => void add([code]), [add]);
  const onPaste = useCallback(
    (text: string) => {
      const codes = codesFromPaste(text);
      if (codes.length < 2) return false;
      void add(codes);
      return true;
    },
    [add],
  );

  function remove(id: string) {
    setDevices((was) => was.filter((device) => device.id !== id));
  }

  function chooseTemplate(next: LabelTemplate) {
    update({ template: next.id });
    setPage(0);
    if (next.kind === 'roll') setSkip(0);
    else setSkip((was) => clampSkip(next, was));
  }

  function setContent(patch: Partial<LabelContent>) {
    update({ content: { ...content, ...patch } });
  }

  const total = printed.length;
  const printLabel = total === 0 ? 'Print' : `Print ${noun(total, 'label', 'labels')}`;

  const summary =
    total === 0
      ? 'Add machines to see their labels.'
      : template.kind === 'sheet'
        ? `${noun(total, 'label', 'labels')} on ${noun(pages, 'sheet', 'sheets')}${startAt > 0 ? `, starting at label ${startAt + 1}` : ''}.`
        : `${noun(total, 'label', 'labels')} off the roll.`;

  return (
    <div className="lp">
      <header className="lp-head page-header">
        <div className="page-header-text">
          <h1>Print labels</h1>
          <p>Asset labels for the machines you pick, on the stock in your printer.</p>
        </div>
        <div className="btn-row">
          <Button variant="primary" icon={Printer} disabled={total === 0} onClick={() => window.print()}>
            {printLabel}
          </Button>
        </div>
      </header>

      <div className="lp-grid">
        <div className="lp-controls">
          <section className="panel lp-panel" aria-labelledby="lp-machines">
            <div className="lp-panel-head">
              <h2 id="lp-machines" className="lp-panel-title">
                Machines <span className="lp-count num">{devices.length}</span>
              </h2>
              {devices.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={() => setDevices([])}>
                  Clear all
                </Button>
              ) : null}
            </div>
            <ScanInput
              id="lp-scan"
              label="Add a machine by its tag or serial"
              placeholder="Scan, type or paste tags"
              hint="A USB scanner types here. Paste a column of tags to add them all."
              active
              onCode={onCode}
              onPasteCodes={onPaste}
            />
            <div className="lp-sources">
              <Button
                size="sm"
                variant={camera ? 'primary' : 'secondary'}
                icon={Camera}
                aria-pressed={camera}
                onClick={() => setCamera((open) => !open)}
              >
                {camera ? 'Camera on' : 'Use camera'}
              </Button>
              <Button
                size="sm"
                variant={pairing ? 'primary' : 'secondary'}
                icon={Smartphone}
                className="lp-pair"
                aria-pressed={pairing}
                onClick={() => setPairing((open) => !open)}
              >
                Scan with your phone
              </Button>
              {adding > 0 ? <span className="lp-adding">Looking up</span> : null}
            </div>
            {camera ? (
              <WorkflowCamera
                onCode={onCode}
                onClose={() => setCamera(false)}
                title="Add machines"
                haptic
                note="Hold each tag in the frame. It is added when it ticks."
                feed={<MachineList devices={devices.slice(-3).reverse()} onRemove={remove} compact />}
              />
            ) : null}
            {pairing ? <PhonePairing label="Print labels" onCode={onCode} onClose={() => setPairing(false)} /> : null}

            {missed.unknown.length > 0 || missed.ambiguous.length > 0 ? (
              <div className="lp-missed" role="status">
                {missed.unknown.length > 0 ? (
                  <p>
                    Not in the inventory: <span className="mono">{missed.unknown.join(', ')}</span>. Check the tag and
                    add it again.
                  </p>
                ) : null}
                {missed.ambiguous.length > 0 ? (
                  <p>
                    More than one machine has <span className="mono">{missed.ambiguous.join(', ')}</span>. Scan its
                    other label.
                  </p>
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => setMissed({ unknown: [], ambiguous: [] })}>
                  Dismiss
                </Button>
              </div>
            ) : null}

            {devices.length === 0 ? (
              <p className="lp-empty">
                Nothing yet. Scan a tag, or pick machines on Devices and choose Print labels.
              </p>
            ) : (
              <MachineList devices={devices} onRemove={remove} />
            )}
          </section>

          <section className="panel lp-panel" aria-labelledby="lp-stock">
            <h2 id="lp-stock" className="lp-panel-title">
              Stock
            </h2>
            <div className="lp-stock" role="radiogroup" aria-labelledby="lp-stock">
              {LABEL_TEMPLATES.map((option) => {
                const ratio = option.label.width / option.label.height;
                return (
                  <label key={option.id} className="lp-stock-option" data-checked={option.id === template.id || undefined}>
                    <input
                      type="radio"
                      name="lp-stock"
                      className="visually-hidden"
                      checked={option.id === template.id}
                      onChange={() => chooseTemplate(option)}
                    />
                    <span className="lp-stock-glyph" aria-hidden="true">
                      <span style={{ width: `${Math.min(36, 12 * ratio)}px`, height: `${Math.min(36, 12 * ratio) / ratio}px` }} />
                    </span>
                    <span className="lp-stock-text">
                      <span className="lp-stock-name">{option.name}</span>
                      <span className="lp-stock-detail">{option.detail}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="panel lp-panel" aria-labelledby="lp-content">
            <h2 id="lp-content" className="lp-panel-title">
              On the label
            </h2>
            <SegmentedControl<LabelSymbol>
              label="Code"
              size="sm"
              value={content.symbol}
              onChange={(symbol) => setContent({ symbol })}
              options={[
                { value: 'barcode', label: 'Barcode' },
                { value: 'qr', label: 'QR code' },
              ]}
            />
            <div className="lp-checks">
              {(
                [
                  ['tag', 'Asset tag, in large type'],
                  ['serial', 'Serial number'],
                  ['model', 'Make and model'],
                  ['property', 'Property of Thomas A. Edison CTE HS — IT'],
                ] as const
              ).map(([key, text]) => (
                <label key={key} className="check">
                  <input
                    type="checkbox"
                    checked={content[key]}
                    onChange={(event) => setContent({ [key]: event.target.checked })}
                  />
                  <span>{text}</span>
                </label>
              ))}
            </div>
            <div className="lp-numbers">
              <Stepper
                id="lp-copies"
                label="Copies of each"
                value={copies}
                min={1}
                max={10}
                onChange={(value) => update({ copies: value })}
              />
              {template.kind === 'sheet' ? (
                <Stepper
                  id="lp-skip"
                  label="Start at label"
                  value={startAt + 1}
                  min={1}
                  max={perPage(template)}
                  onChange={(value) => {
                    setSkip(value - 1);
                    setPage(0);
                  }}
                />
              ) : null}
            </div>
            {template.kind === 'sheet' ? (
              <p className="lp-hint">On a partly used sheet, press the first free label on the preview.</p>
            ) : null}
          </section>
        </div>

        <div className="lp-preview" aria-label="Preview">
          <div className="lp-preview-head">
            <p className="lp-summary" aria-live="polite">
              {summary}
            </p>
            {template.kind === 'sheet' && pages > 1 ? (
              <div className="lp-pager">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ChevronLeft}
                  aria-label="Previous sheet"
                  disabled={shownPage === 0}
                  onClick={() => setPage(shownPage - 1)}
                />
                <span className="num">
                  Sheet {shownPage + 1} of {pages}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ChevronRight}
                  aria-label="Next sheet"
                  disabled={shownPage >= pages - 1}
                  onClick={() => setPage(shownPage + 1)}
                />
              </div>
            ) : null}
          </div>

          {warnings.length > 0 ? (
            <ul className="lp-warnings">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}

          {template.kind === 'sheet' ? (
            <div className="lp-paper">
              <Scaled width={template.page.width} height={template.page.height}>
                <LabelSheet
                  template={template}
                  labels={byPage[shownPage] ?? []}
                  content={content}
                  layout={layout}
                  preview={{
                    used: shownPage === 0 ? startAt : 0,
                    onPick:
                      shownPage === 0
                        ? (slot) => {
                            setSkip(slot);
                          }
                        : undefined,
                  }}
                />
              </Scaled>
            </div>
          ) : (
            <ul className="lp-roll">
              {(byPage.length === 0 ? [[]] : byPage.slice(0, 6)).map((labels, index) => (
                <li key={labels[0]?.key ?? `empty-${index}`} className="lp-roll-label">
                  <Scaled width={template.page.width} height={template.page.height} maxScale={1.6}>
                    <LabelSheet template={template} labels={labels} content={content} layout={layout} preview={{ used: 0 }} />
                  </Scaled>
                </li>
              ))}
              {pages > 6 ? <li className="lp-roll-more">and {noun(pages - 6, 'more label', 'more labels')}</li> : null}
            </ul>
          )}
          <p className="lp-print-note">
            In the print dialog, choose the label printer, paper size {template.kind === 'sheet' ? 'Letter' : 'to match the label'}, and
            scale 100%.
          </p>
        </div>
      </div>

      {body && total > 0
        ? createPortal(
            <div className="label-print" aria-hidden="true">
              <style>{pageRule(template)}</style>
              {byPage.map((labels, index) => (
                <LabelSheet key={index} template={template} labels={labels} content={content} layout={layout} />
              ))}
            </div>,
            body,
          )
        : null}
    </div>
  );
}

function MachineList({
  devices,
  onRemove,
  compact = false,
}: {
  devices: LabelDevice[];
  onRemove: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <ul className="lp-machines" data-compact={compact || undefined}>
      {devices.map((device) => (
        <li key={device.id} className="lp-machine">
          <span className="lp-machine-text">
            <span className="mono lp-machine-code">{device.code}</span>
            <span className="lp-machine-meta">
              {[modelLine(device), codeSource(device) === 'tag' ? '' : `no asset tag, printing the ${codeSource(device) === 'serial' ? 'serial' : 'inventory id'}`]
                .filter(Boolean)
                .join(', ')}
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            icon={X}
            className="lp-machine-remove"
            aria-label={`Remove ${device.code}`}
            onClick={() => onRemove(device.id)}
          />
        </li>
      ))}
    </ul>
  );
}

function Stepper({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const set = (next: number) => onChange(Math.min(max, Math.max(min, Math.floor(next) || min)));
  return (
    <div className="lp-stepper">
      <label htmlFor={id} className="lp-stepper-label">
        {label}
      </label>
      <div className="lp-stepper-row">
        <Button
          variant="secondary"
          size="sm"
          icon={Minus}
          aria-label={`Fewer: ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => set(value - 1)}
        />
        <input
          id={id}
          className="lp-stepper-input num"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          onChange={(event) => set(Number(event.target.value))}
        />
        <Button
          variant="secondary"
          size="sm"
          icon={Plus}
          aria-label={`More: ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => set(value + 1)}
        />
      </div>
    </div>
  );
}

