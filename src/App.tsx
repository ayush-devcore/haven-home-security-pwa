
import { useState } from "react";
import "./App.css";

type Tab = "Overview" | "Events" | "Camera" | "Settings";

const navigation: { name: Tab; icon: string }[] = [
  { name: "Overview", icon: "⌂" },
  { name: "Events", icon: "◷" },
  { name: "Camera", icon: "▣" },
  { name: "Settings", icon: "⚙" },
];

const devices = [
  {
    icon: "◉",
    name: "Motion sensor",
    detail: "HC-SR501 PIR",
    status: "Awaiting connection",
  },
  {
    icon: "▤",
    name: "Door sensor",
    detail: "Magnetic reed switch",
    status: "Awaiting connection",
  },
  {
    icon: "◖",
    name: "Alarm system",
    detail: "Buzzer and indicators",
    status: "Awaiting connection",
  },
  {
    icon: "▧",
    name: "Security camera",
    detail: "ESP32-CAM",
    status: "Awaiting connection",
  },
];

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("Overview");
  const [armedPreview, setArmedPreview] = useState(false);
  const [notice, setNotice] = useState("");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#home"
          onClick={() => setActiveTab("Overview")}
        >
          <span className="brand-mark">⌂</span>
          <span>
            <strong>Haven</strong>
            <small>HOME SECURITY</small>
          </span>
        </a>

        <div className="sidebar-label">WORKSPACE</div>

        <nav className="navigation" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              key={item.name}
              className={`nav-item ${
                activeTab === item.name ? "active" : ""
              }`}
              onClick={() => {
                setActiveTab(item.name);
                setNotice("");
              }}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.name}</span>
              {item.name === "Events" && (
                <span className="nav-count">0</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="connection-card">
            <span className="connection-dot" />
            <div>
              <strong>Device offline</strong>
              <small>Setup in progress</small>
            </div>
          </div>
          <p className="sidebar-footer">HAVEN · PERSONAL SECURITY</p>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Haven</span>
            <span className="crumb-separator">/</span>
            <strong>{activeTab}</strong>
          </div>
          <span className="mode-badge">
            <span className="status-dot" />
            LOCAL PREVIEW
          </span>
        </header>

        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button onClick={() => setNotice("")} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {activeTab === "Overview" && (
          <>
            <section className="page-heading">
              <div>
                <p className="eyebrow">YOUR HOME, IN CONTROL</p>
                <h1>Security overview</h1>
                <p className="page-subtitle">
                  Monitor your home and stay informed.
                </p>
              </div>
              <span className="preview-chip">DEVELOPMENT MODE</span>
            </section>

            <section className="hero-card">
              <div className="hero-copy">
                <div className="hero-status">
                  <span className="hero-status-dot" />
                  {armedPreview
                    ? "ARMED · PREVIEW ONLY"
                    : "SYSTEM NOT CONNECTED"}
                </div>

                <h2>
                  {armedPreview
                    ? "Preview armed."
                    : "Your safety starts here."}
                </h2>

                <p>
                  {armedPreview
                    ? "This is a visual simulation. Your physical alarm is not being controlled."
                    : "Connect your security controller to start receiving real sensor updates and alerts."}
                </p>

                <button
                  className={`primary-button ${
                    armedPreview ? "disarm-button" : ""
                  }`}
                  onClick={() => {
                    setArmedPreview(!armedPreview);
                    setNotice(
                      !armedPreview
                        ? "Preview armed locally. No hardware command was sent."
                        : "Preview disarmed locally. No hardware command was sent."
                    );
                  }}
                >
                  <span>{armedPreview ? "Ⅱ" : "↗"}</span>
                  {armedPreview ? "Disarm preview" : "Arm preview"}
                </button>

                <small className="hero-disclaimer">
                  Preview only · Hardware integration pending
                </small>
              </div>

              <div className="hero-visual" aria-hidden="true">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="shield">
                  <svg
                    viewBox="0 0 100 112"
                    role="presentation"
                    className="shield-svg"
                  >
                    <path
                      d="M50 5 88 20 V50 C88 76 72 94 50 106 C28 94 12 76 12 50 V20 Z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="4"
                      strokeLinejoin="round"
                    />
                    <path
                      d="m33 53 12 12 24-27"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <span className="visual-caption">
                  PROTECTION STARTS WITH CONNECTION
                </span>
              </div>
            </section>

            <section className="section">
              <div className="section-heading">
                <div>
                  <h2>Security devices</h2>
                  <p>Hardware readiness at a glance.</p>
                </div>
                <span className="count-badge">0 / 4 ONLINE</span>
              </div>

              <div className="device-grid">
                {devices.map((device) => (
                  <article className="device-card" key={device.name}>
                    <div className="device-card-top">
                      <span className="device-icon">{device.icon}</span>
                      <span className="offline-pill">OFFLINE</span>
                    </div>
                    <h3>{device.name}</h3>
                    <p className="device-detail">{device.detail}</p>
                    <div className="device-divider" />
                    <p className="device-status">
                      <span className="status-dot" />
                      {device.status}
                    </p>
                  </article>
                ))}
              </div>
            </section>

            <section className="bottom-grid">
              <article className="panel">
                <div className="section-heading">
                  <div>
                    <h2>Recent activity</h2>
                    <p>Your latest security events.</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setActiveTab("Events")}
                  >
                    View history →
                  </button>
                </div>
                <div className="empty-state">
                  <span className="empty-icon">◷</span>
                  <strong>No events received yet</strong>
                  <p>
                    Real motion and door events will appear here after
                    your device connects.
                  </p>
                </div>
              </article>

              <article className="panel setup-panel">
                <div className="section-heading">
                  <div>
                    <h2>Getting started</h2>
                    <p>Your setup checklist.</p>
                  </div>
                </div>
                <div className="setup-row">
                  <span className="setup-number">01</span>
                  <div>
                    <strong>Connect your ESP32</strong>
                    <p>Configure Wi-Fi and device communication.</p>
                  </div>
                </div>
                <div className="setup-row">
                  <span className="setup-number">02</span>
                  <div>
                    <strong>Enable notifications</strong>
                    <p>We'll configure real push alerts later.</p>
                  </div>
                </div>
                <div className="setup-row">
                  <span className="setup-number">03</span>
                  <div>
                    <strong>Connect the camera</strong>
                    <p>Add your ESP32-CAM live feed.</p>
                  </div>
                </div>
              </article>
            </section>
          </>
        )}

        {activeTab === "Events" && (
          <section className="standalone-panel">
            <p className="eyebrow">SECURITY LOG</p>
            <h1>Event history</h1>
            <p className="page-subtitle">
              A timeline of motion, door activity and alarms.
            </p>
            <div className="empty-state large-empty">
              <span className="empty-icon">◷</span>
              <strong>No real events recorded</strong>
              <p>
                Events will be saved after the backend and ESP32
                integration are implemented.
              </p>
            </div>
          </section>
        )}

        {activeTab === "Camera" && (
          <section className="standalone-panel">
            <p className="eyebrow">VISUAL MONITORING</p>
            <h1>Security camera</h1>
            <p className="page-subtitle">
              Your camera stream will be shown here.
            </p>
            <div className="camera-placeholder">
              <span className="camera-symbol">▧</span>
              <h2>Camera not connected</h2>
              <p>
                The ESP32-CAM stream will appear here after camera
                setup and connection.
              </p>
            </div>
          </section>
        )}

        {activeTab === "Settings" && (
          <section className="standalone-panel">
            <p className="eyebrow">CONFIGURATION</p>
            <h1>Settings</h1>
            <p className="page-subtitle">
              Manage your security system setup.
            </p>
            <div className="settings-card">
              <div>
                <strong>Controller</strong>
                <p>ESP32 DevKit · GPIO27 motion input</p>
              </div>
              <span className="offline-pill">NOT CONNECTED</span>
            </div>
            <div className="settings-card">
              <div>
                <strong>Notifications</strong>
                <p>Browser push notifications are not configured yet.</p>
              </div>
              <span className="offline-pill">NOT SET UP</span>
            </div>
            <div className="settings-card">
              <div>
                <strong>Application</strong>
                <p>Haven local development preview.</p>
              </div>
              <span className="offline-pill">LOCAL</span>
            </div>
          </section>
        )}

        <footer className="app-footer">
          <span>HAVEN HOME SECURITY</span>
          <span>Built for a safer home.</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
