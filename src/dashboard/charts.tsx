interface Series { label: string; values: Array<number | null>; color: string; }

export function TrendChart({ labels, series }: { labels: string[]; series: Series[] }) {
  const width = 760;
  const height = 240;
  const padding = 30;
  const finite = series.flatMap((item) => item.values.filter((value): value is number => value !== null));
  if (labels.length < 2 || !finite.length) return <div className="chart-empty">Trend appears after two compatible snapshots.</div>;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const x = (index: number) => padding + (index / Math.max(1, labels.length - 1)) * (width - padding * 2);
  const y = (value: number) => height - padding - ((value - min) / Math.max(1, max - min)) * (height - padding * 2);
  return <div className="chart-wrap"><svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${series.map((item) => item.label).join(", ")} trend`}><title>{series.map((item) => item.label).join(", ")} trend across permanent snapshots</title>{[0, 1, 2, 3].map((line) => <line key={line} x1={padding} x2={width - padding} y1={padding + line * 60} y2={padding + line * 60} className="gridline" />)}{series.map((item) => { const points = item.values.map((value, index) => value === null ? null : `${x(index)},${y(value)}`).filter(Boolean).join(" "); return <polyline key={item.label} points={points} fill="none" stroke={item.color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />; })}</svg><div className="chart-legend">{series.map((item) => <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>)}</div></div>;
}

function contiguousSegments(values: Array<number | null>): number[][] {
  const segments: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(index);
    }
  });
  if (current.length) segments.push(current);
  return segments;
}

export function MetricChart({
  labels,
  values,
  label,
  color,
  valueLabel = (value) => new Intl.NumberFormat().format(value),
}: {
  labels: string[];
  values: Array<number | null>;
  label: string;
  color: string;
  valueLabel?: (value: number) => string;
}) {
  const width = 760;
  const height = 240;
  const padding = 34;
  const finite = values.filter((value): value is number => value !== null);
  if (labels.length < 2 || !finite.length) return <div className="chart-empty">Trend appears after two dated snapshots.</div>;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const x = (index: number) => padding + (index / Math.max(1, labels.length - 1)) * (width - padding * 2);
  const y = (value: number) => height - padding - ((value - min) / Math.max(1, max - min)) * (height - padding * 2);
  const segments = contiguousSegments(values);
  return <div className="chart-wrap metric-chart"><svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label} over time. Missing observations are shown as gaps.`}><title>{label} across permanent snapshots; missing observations are gaps</title>{[0, 1, 2, 3].map((line) => <line key={line} x1={padding} x2={width - padding} y1={padding + line * 58} y2={padding + line * 58} className="gridline" />)}{segments.filter((segment) => segment.length > 1).map((segment) => <polyline key={segment.join("-")} data-segment="observed" points={segment.map((index) => `${x(index)},${y(values[index]!)}`).join(" ")} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />)}{values.map((value, index) => value === null ? null : <circle key={`${labels[index]}:${value}`} cx={x(index)} cy={y(value)} r="5" fill={color} stroke="var(--panel-solid)" strokeWidth="3" tabIndex={0} role="img" aria-label={`${labels[index]}: ${valueLabel(value)}`}><title>{labels[index]}: {valueLabel(value)}</title></circle>)}<text x={padding} y={height - 5}>{labels[0]}</text><text x={width - padding} y={height - 5} textAnchor="end">{labels.at(-1)}</text></svg><table className="sr-only"><caption>{label} values by UTC report date; missing values are not interpolated.</caption><thead><tr><th>Date</th><th>{label}</th></tr></thead><tbody>{labels.map((date, index) => <tr key={date}><td>{date}</td><td>{values[index] === null ? "Not captured" : valueLabel(values[index]!)}</td></tr>)}</tbody></table></div>;
}

export function RankChart({ values }: { values: Array<{ label: string; rank: number | null }> }) {
  const ranked = values.filter((item): item is { label: string; rank: number } => item.rank !== null);
  if (values.length < 2 || !ranked.length) return <div className="chart-empty">Rank trend appears after two compatible snapshots.</div>;
  const maximum = Math.max(10, ...ranked.map((item) => item.rank));
  const width = 760;
  const height = 220;
  const padding = 30;
  const points = values.map((item, index) => item.rank === null ? null : `${padding + index / Math.max(1, values.length - 1) * (width - padding * 2)},${padding + (item.rank - 1) / Math.max(1, maximum - 1) * (height - padding * 2)}`).filter(Boolean).join(" ");
  return <svg className="trend-chart rank-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Query rank trend, where higher on the chart is a better rank"><title>Query rank trend; higher is better</title>{[1, Math.ceil(maximum / 2), maximum].map((rank) => <g key={rank}><line x1={padding} x2={width - padding} y1={padding + (rank - 1) / Math.max(1, maximum - 1) * (height - padding * 2)} y2={padding + (rank - 1) / Math.max(1, maximum - 1) * (height - padding * 2)} className="gridline" /><text x="2" y={padding + (rank - 1) / Math.max(1, maximum - 1) * (height - padding * 2) + 4}>#{rank}</text></g>)}<polyline points={points} fill="none" stroke="var(--cyan)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
