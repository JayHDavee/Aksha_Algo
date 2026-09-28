import React, { useEffect, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
  ChartData,
  ChartOptions,
} from "chart.js";
import { Bar } from "react-chartjs-2";
import axiosJWT from "../../context/axiosAuthIntercept";
import { useFeatureFlags } from "../../context/FeatureFlagsContext";
import "./jewelryDashboard.scss";

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const VITE_base_url = `${import.meta.env.VITE_BASE_URL_PROTOCOL}://${window.location.hostname}:${import.meta.env.VITE_BASE_URL_PORT}`;

interface Summary {
  active_alerts: number;
  alerts_today: number;
  critical_active: number;
  by_severity: { critical: number; high: number; medium: number; low: number };
}

interface JewelryAlert {
  id: string;
  camera_name: string;
  rule: string | null;
  severity: string;
  zone: string | null;
  timestamp: string;
  status: string;
  frame_url: string | null;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#d64545",
  high: "#e08a2f",
  medium: "#d6b53a",
  low: "#4a8f5c",
};

const formatRuleName = (rule: string | null) =>
  rule ? rule.replace(/_/g, " ").replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) : "Unknown";

/**
 * Jewelry Dashboard
 *
 * Metrics are sourced entirely from the shared `alerts` collection (see
 * AkshaV2-UIUX/backend/src/routes/jewelryDashboard.ts) — every rule fired by
 * the jewelry detection service, not a face-recognition/vault/attendance
 * view (explicitly out of scope for this pass). The "Alert Volume" chart is
 * hourly alert counts, not true continuous footfall — see that route file's
 * header comment for why a true footfall time series isn't available yet.
 */
const JewelryDashboard: React.FC = () => {
  const { JEWELRY_DETECTION } = useFeatureFlags();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<JewelryAlert[]>([]);
  const [hourly, setHourly] = useState<{ hour: number; alert_count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!JEWELRY_DETECTION) {
      setLoading(false);
      return;
    }

    const load = () => {
      Promise.all([
        axiosJWT.get(`${VITE_base_url}/api/jewelry/dashboard/summary`),
        axiosJWT.get(`${VITE_base_url}/api/jewelry/dashboard/alerts?limit=20`),
        axiosJWT.get(`${VITE_base_url}/api/jewelry/dashboard/footfall`),
      ])
        .then(([summaryRes, alertsRes, footfallRes]) => {
          if (summaryRes.data?.success) setSummary(summaryRes.data.summary);
          if (alertsRes.data?.success) setAlerts(alertsRes.data.alerts);
          if (footfallRes.data?.success) setHourly(footfallRes.data.hourly);
          setError(false);
        })
        .catch(() => setError(true))
        .finally(() => setLoading(false));
    };

    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [JEWELRY_DETECTION]);

  if (!JEWELRY_DETECTION) {
    return (
      <div style={{ marginTop: 68, padding: 24 }}>
        <p>Jewelry detection is not enabled for this deployment.</p>
      </div>
    );
  }

  const chartData: ChartData<"bar"> = {
    labels: hourly.map((h) => `${h.hour}:00`),
    datasets: [
      {
        label: "Alerts",
        data: hourly.map((h) => h.alert_count),
        backgroundColor: "#035faa",
        borderRadius: 4,
      },
    ],
  };

  const chartOptions: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false } },
      y: { beginAtZero: true, ticks: { precision: 0 } },
    },
  };

  return (
    <div style={{ marginTop: 68 }} className="jewelry-dashboard">
      <div className="kpi-layout">
        <div className="jewelry-kpi-row">
          <div className="kpi-card jewelry-kpi-tile">
            <div className="kpi-card-header">Active Alerts</div>
            <div className="kpi-card-body jewelry-kpi-value">{summary?.active_alerts ?? "—"}</div>
          </div>
          <div className="kpi-card jewelry-kpi-tile">
            <div className="kpi-card-header">Alerts Today</div>
            <div className="kpi-card-body jewelry-kpi-value">{summary?.alerts_today ?? "—"}</div>
          </div>
          <div className="kpi-card jewelry-kpi-tile">
            <div className="kpi-card-header">Critical Active</div>
            <div className="kpi-card-body jewelry-kpi-value" style={{ color: SEVERITY_COLOR.critical }}>
              {summary?.critical_active ?? "—"}
            </div>
          </div>
          <div className="kpi-card jewelry-kpi-tile">
            <div className="kpi-card-header">By Severity</div>
            <div className="kpi-card-body jewelry-severity-breakdown">
              {summary &&
                (["critical", "high", "medium", "low"] as const).map((sev) => (
                  <span key={sev} className="jewelry-severity-chip" style={{ color: SEVERITY_COLOR[sev] }}>
                    {sev}: {summary.by_severity[sev]}
                  </span>
                ))}
            </div>
          </div>
        </div>

        <div className="jewelry-dashboard-row">
          <div className="kpi-card jewelry-chart-card">
            <div className="kpi-card-header">Alert Volume (last 24h)</div>
            <div className="kpi-card-body" style={{ height: 280 }}>
              {hourly.length > 0 ? (
                <Bar data={chartData} options={chartOptions} />
              ) : (
                <p className="jewelry-empty-note">No jewelry alerts in the last 24 hours.</p>
              )}
            </div>
          </div>

          <div className="kpi-card jewelry-alerts-card">
            <div className="kpi-card-header">Recent Alerts</div>
            <div className="kpi-card-body jewelry-alert-list">
              {alerts.length === 0 && <p className="jewelry-empty-note">No jewelry alerts yet.</p>}
              {alerts.map((a) => (
                <div key={a.id} className="jewelry-alert-row">
                  <span className="jewelry-alert-severity" style={{ backgroundColor: SEVERITY_COLOR[a.severity?.toLowerCase()] || "#888" }} />
                  <div className="jewelry-alert-info">
                    <div className="jewelry-alert-title">
                      {formatRuleName(a.rule)} — {a.camera_name}
                    </div>
                    <div className="jewelry-alert-meta">
                      {a.zone ? `${a.zone} · ` : ""}
                      {new Date(a.timestamp).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {error && <p className="jewelry-empty-note">Could not reach the jewelry dashboard service.</p>}
        {loading && !summary && <p className="jewelry-empty-note">Loading…</p>}
      </div>
    </div>
  );
};

export default JewelryDashboard;
