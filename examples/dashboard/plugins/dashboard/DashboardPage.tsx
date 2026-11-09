import { usePluginData, Loading, Muted } from '@jannik-stacks/agi/studio';
import { DashboardData } from './data.ts';
import './dashboard.css';

const WidgetChart = ({ widget }: { widget: (typeof DashboardData.Type)['widgets'][number] }) => {
  const days = [...new Set(widget.rows.map(row => row.day))];
  const series = [...new Set(widget.rows.map(row => row.series))];
  const maximum = Math.max(1, ...widget.rows.map(row => row.value));
  return (
    <svg viewBox="0 0 600 190" role="img" aria-label={`${widget.title}, daily ${widget.source}`}>
      <title>{widget.title}</title>
      <text x="0" y="12">
        {maximum.toLocaleString()}
      </text>
      <path d="M40 20V160H590" fill="none" stroke="currentColor" opacity="0.3" />
      {series.map((name, index) => {
        const rows = widget.rows.filter(row => row.series === name);
        const width = 540 / days.length;
        return (
          <g key={name} className={`dashboard-series-${index}`}>
            {widget.type === 'line' ? (
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                points={rows
                  .map((row, i) => `${40 + (i + 0.5) * width},${160 - (row.value / maximum) * 135}`)
                  .join(' ')}
              />
            ) : null}
            {rows.map((row, i) =>
              widget.type === 'bar' ? (
                <rect
                  key={row.day}
                  x={40 + i * width + (index * width) / series.length}
                  y={160 - (row.value / maximum) * 135}
                  width={Math.max(0.5, width / series.length - 1)}
                  height={(row.value / maximum) * 135}
                  fill="currentColor"
                >
                  <title>{`${row.day}: ${name} ${row.value.toLocaleString()}`}</title>
                </rect>
              ) : (
                <circle
                  key={row.day}
                  cx={40 + (i + 0.5) * width}
                  cy={160 - (row.value / maximum) * 135}
                  r="2.5"
                  fill="currentColor"
                >
                  <title>{`${row.day}: ${name} ${row.value.toLocaleString()}`}</title>
                </circle>
              )
            )}
          </g>
        );
      })}
      <text x="40" y="185">
        {days[0]}
      </text>
      <text x="590" y="185" textAnchor="end">
        {days.at(-1)}
      </text>
    </svg>
  );
};

const DashboardPage = () => {
  const { value, failure, retry } = usePluginData('dashboard', DashboardData);
  if (!value)
    return failure ? (
      <Muted>
        {failure} <button onClick={retry}>Retry</button>
      </Muted>
    ) : (
      <Loading />
    );
  return (
    <main className="dashboard-page">
      <h1>Dashboard</h1>
      <p>Live snapshots, last read {new Date(value.at).toLocaleString()}. Days use UTC.</p>
      {failure ? (
        <p role="alert">
          Could not refresh. Showing earlier data. {failure} <button onClick={retry}>Retry</button>
        </p>
      ) : null}
      {!value.widgets.length ? <p>No widgets configured in plugins.dashboard.widgets.</p> : null}
      <div className="dashboard-widgets">
        {value.widgets.map((widget, index) => {
          const series = [...new Set(widget.rows.map(row => row.series))];
          const totals = series.map(name => ({
            name,
            value: widget.rows.filter(row => row.series === name).reduce((sum, row) => sum + row.value, 0),
          }));
          return (
            <section key={index}>
              <h2>{widget.title}</h2>
              <p>
                {widget.source === 'runs'
                  ? 'Current state by start day'
                  : widget.source === 'checks'
                    ? 'All check attempts by check day'
                    : 'Reported usage by event day'}
              </p>
              <ul className="dashboard-totals">
                {totals.map(({ name, value }, index) => (
                  <li key={name} className={`dashboard-series-${index}`}>
                    <strong>{value.toLocaleString(undefined, { maximumFractionDigits: 4 })}</strong> {name}
                  </li>
                ))}
              </ul>
              {widget.type === 'line' || widget.type === 'bar' ? <WidgetChart widget={widget} /> : null}
              {widget.type !== 'counter' ? (
                <details open={widget.type === 'table'}>
                  <summary>Daily values</summary>
                  <table>
                    <caption>{widget.title}, UTC days</caption>
                    <thead>
                      <tr>
                        <th scope="col">Day</th>
                        <th scope="col">Series</th>
                        <th scope="col">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {widget.rows.map(row => (
                        <tr key={`${row.day}/${row.series}`}>
                          <td>{row.day}</td>
                          <td>{row.series}</td>
                          <td>{row.value.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ) : null}
              {widget.skipped ? (
                <p role="status">
                  Skipped {widget.skipped}: {widget.why}.
                </p>
              ) : null}
            </section>
          );
        })}
      </div>
    </main>
  );
};

export default DashboardPage;
