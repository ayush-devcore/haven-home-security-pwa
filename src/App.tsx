import { useEffect, useRef, useState, type FormEvent } from "react";
import "./App.css";

type Tab = "Overview" | "Events" | "Camera" | "Settings";

type EventType =
  | "motion_detected"
  | "door_opened"
  | "alarm_triggered"
  | "device_online"
  | "device_offline"
  | "system_armed"
  | "system_disarmed";

type HardwareEventType = Exclude<EventType, "system_armed" | "system_disarmed">;
type SimulatedEventType = HardwareEventType;

type SystemStatus = {
  armed: boolean;
  updated_at: string;
  mode: "software-only";
  hardware_connected: boolean;
};

type SecurityEvent = {
  id: string;
  event_type: EventType;
  device_id: string;
  message: string;
  received_at: string;
};

type ApiStatus = "checking" | "online" | "offline";

type PushStatus = {
  configured: boolean;
  subscribed: boolean;
  subscription_count: number;
};

type PushSubscriptionJSON = {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
};

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000"
).replace(/\/+$/, "");

const eventLabels: Record<EventType, string> = {
  motion_detected: "Motion detected",
  door_opened: "Door opened",
  alarm_triggered: "Alarm triggered",
  device_online: "Device online",
  device_offline: "Device offline",
  system_armed: "System armed",
  system_disarmed: "System disarmed",
};

const eventSymbols: Record<EventType, string> = {
  motion_detected: "↗",
  door_opened: "⌂",
  alarm_triggered: "!",
  device_online: "+",
  device_offline: "−",
  system_armed: "✓",
  system_disarmed: "Ⅱ",
};

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
    detail: "HC-SR501 PIR · GPIO27",
  },
  {
    icon: "▤",
    name: "Door sensor",
    detail: "Magnetic reed switch · GPIO26",
  },
  {
    icon: "◖",
    name: "Alarm system",
    detail: "Buzzer and indicators",
  },
  {
    icon: "▧",
    name: "Security camera",
    detail: "AI-Thinker ESP32-CAM",
  },
];

function formatEventTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Time unavailable";

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return buffer;
}

function getApiError(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null && "detail" in payload) {
    return String(payload.detail);
  }
  return fallback;
}

function EventList({ events }: { events: SecurityEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon" aria-hidden="true">
          ◷
        </span>
        <strong>No events recorded</strong>
        <p>Events accepted by the API will appear here. Test events may be simulated until the hardware is connected.</p>
      </div>
    );
  }

  return (
    <div className="event-list" aria-label="Security events">
      {events.map((event) => (
        <article className="event-row" key={event.id}>
          <span
            className={`event-mark ${event.event_type}`}
            aria-hidden="true"
          >
            {eventSymbols[event.event_type]}
          </span>

          <div className="event-copy">
            <strong>{eventLabels[event.event_type]}</strong>
            <p>{event.message}</p>
            <span className="event-device">Device: {event.device_id}</span>
          </div>

          <time dateTime={event.received_at} title={event.received_at}>
            {formatEventTime(event.received_at)}
          </time>
        </article>
      ))}
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("Overview");
  const [notice, setNotice] = useState("");
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState("");
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [systemBusy, setSystemBusy] = useState(false);
  const [simulationBusy, setSimulationBusy] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [signedInUsername, setSignedInUsername] = useState("");
  const [authError, setAuthError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [alerts, setAlerts] = useState<SecurityEvent[]>([]);
  const seenEventIdsRef = useRef<Set<string> | null>(null);
  const [pushStatus, setPushStatus] = useState<PushStatus>({
    configured: false,
    subscribed: false,
    subscription_count: 0,
  });
  const [pushBusy, setPushBusy] = useState(false);
  const [pushFeedback, setPushFeedback] = useState("");

  // The access token is deliberately kept in React memory, not localStorage.
  // Refreshing the page clears it and requires the user to sign in again.
  useEffect(() => {
    if (!accessToken) {
      setEvents([]);
      setEventsLoading(false);
      setEventsError("");
      setSystemStatus(null);
      setApiStatus("checking");
      seenEventIdsRef.current = null;
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const loadEvents = async () => {
      if (inFlight) return;
      inFlight = true;

      try {
        const headers = {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        };
        const [eventsResponse, statusResponse] = await Promise.all([
          fetch(`${API_BASE_URL}/api/events`, { headers }),
          fetch(`${API_BASE_URL}/api/system/status`, { headers }),
        ]);

        if (
          eventsResponse.status === 401 ||
          eventsResponse.status === 403 ||
          statusResponse.status === 401 ||
          statusResponse.status === 403
        ) {
          if (!cancelled) {
            setAccessToken(null);
            setEvents([]);
            setSystemStatus(null);
            setAuthError("Your session expired. Please sign in again.");
          }
          return;
        }

        if (!eventsResponse.ok) {
          throw new Error(`Event request failed with HTTP ${eventsResponse.status}`);
        }
        if (!statusResponse.ok) {
          throw new Error(`System status request failed with HTTP ${statusResponse.status}`);
        }

        const eventData: unknown = await eventsResponse.json();
        const statusData: unknown = await statusResponse.json();
        if (!Array.isArray(eventData)) {
          throw new Error("API returned an unexpected event list.");
        }
        if (
          typeof statusData !== "object" ||
          statusData === null ||
          !("armed" in statusData) ||
          typeof statusData.armed !== "boolean"
        ) {
          throw new Error("API returned an unexpected system status.");
        }

        if (!cancelled) {
          const fetchedEvents = eventData as SecurityEvent[];
          const previouslySeen = seenEventIdsRef.current;
          if (previouslySeen === null) {
            // Don't create alerts for old events already in the database at sign-in.
            seenEventIdsRef.current = new Set(fetchedEvents.map((item) => item.id));
          } else {
            const freshEvents = fetchedEvents.filter((item) => !previouslySeen.has(item.id));
            if (freshEvents.length > 0) {
              setAlerts((previous) => [...freshEvents, ...previous].slice(0, 4));
            }
            const combinedIds = [...previouslySeen, ...fetchedEvents.map((item) => item.id)];
            seenEventIdsRef.current = new Set(combinedIds.slice(-200));
          }
          setEvents(fetchedEvents);
          setSystemStatus(statusData as SystemStatus);
          setEventsError("");
          setApiStatus("online");
        }
      } catch (error) {
        if (!cancelled) {
          setApiStatus("offline");
          setEventsError(
            error instanceof Error
              ? error.message
              : "Unable to connect to the Haven API.",
          );
        }
      } finally {
        inFlight = false;
        if (!cancelled) setEventsLoading(false);
      }
    };

    setEventsLoading(true);
    void loadEvents();
    const timer = window.setInterval(() => void loadEvents(), 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) {
      setPushStatus({ configured: false, subscribed: false, subscription_count: 0 });
      setPushFeedback("");
      return;
    }

    let cancelled = false;
    const checkPushStatus = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/push/status`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (
          typeof data === "object" && data !== null &&
          "configured" in data && "subscribed" in data && "subscription_count" in data &&
          !cancelled
        ) {
          setPushStatus(data as PushStatus);
        }
      } catch {
        // Push status is optional; the dashboard and event history remain usable.
      }
    };
    void checkPushStatus();
    return () => { cancelled = true; };
  }, [accessToken]);

  const handleEnablePush = async () => {
    if (!accessToken || pushBusy) return;
    setPushBusy(true);
    setPushFeedback("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("This browser does not support web push notifications.");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error(permission === "denied"
          ? "Notifications are blocked by browser settings. Allow them for this site and try again."
          : "Notification permission was not granted.");
      }

      const keyResponse = await fetch(`${API_BASE_URL}/api/push/public-key`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      });
      const keyPayload: unknown = await keyResponse.json().catch(() => null);
      if (!keyResponse.ok) throw new Error(getApiError(keyPayload, `Push setup failed with HTTP ${keyResponse.status}.`));
      if (typeof keyPayload !== "object" || keyPayload === null || !("public_key" in keyPayload) || typeof keyPayload.public_key !== "string") {
        throw new Error("The API returned an invalid push public key.");
      }

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToArrayBuffer(keyPayload.public_key),
        });
      }
      const serialized = subscription.toJSON() as PushSubscriptionJSON;
      if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
        throw new Error("The browser returned an incomplete push subscription.");
      }

      const saveResponse = await fetch(`${API_BASE_URL}/api/push/subscribe`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          endpoint: serialized.endpoint,
          keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth },
        }),
      });
      const savePayload: unknown = await saveResponse.json().catch(() => null);
      if (!saveResponse.ok) throw new Error(getApiError(savePayload, `Saving push subscription failed with HTTP ${saveResponse.status}.`));
      setPushStatus({ configured: true, subscribed: true, subscription_count: Math.max(1, pushStatus.subscription_count) });
      setPushFeedback("Browser push is enabled on this device. Send a test notification to verify delivery.");
    } catch (error) {
      setPushFeedback(error instanceof Error ? error.message : "Unable to enable browser push.");
    } finally {
      setPushBusy(false);
    }
  };

  const handleDisablePush = async () => {
    if (!accessToken || pushBusy) return;
    setPushBusy(true);
    setPushFeedback("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch(`${API_BASE_URL}/api/push/unsubscribe`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(getApiError(payload, `Unsubscribe failed with HTTP ${response.status}.`));
        await subscription.unsubscribe();
      }
      setPushStatus((previous) => ({ ...previous, subscribed: false, subscription_count: 0 }));
      setPushFeedback("Browser push has been disabled on this device.");
    } catch (error) {
      setPushFeedback(error instanceof Error ? error.message : "Unable to disable browser push.");
    } finally {
      setPushBusy(false);
    }
  };

  const handleTestPush = async () => {
    if (!accessToken || pushBusy) return;
    setPushBusy(true);
    setPushFeedback("");
    try {
      const response = await fetch(`${API_BASE_URL}/api/push/test`, {
        method: "POST",
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(getApiError(payload, `Test notification failed with HTTP ${response.status}.`));
      setPushFeedback("Test push sent. Check your browser or operating-system notifications.");
    } catch (error) {
      setPushFeedback(error instanceof Error ? error.message : "Unable to send a test notification.");
    } finally {
      setPushBusy(false);
    }
  };

  const handleSystemToggle = async () => {
    if (!accessToken || !systemStatus || systemBusy) return;
    setSystemBusy(true);
    setNotice("");
    try {
      const response = await fetch(`${API_BASE_URL}/api/system/arm`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ armed: !systemStatus.armed }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401 || response.status === 403) {
        setAccessToken(null);
        setAuthError("Your session expired. Please sign in again.");
        return;
      }
      if (!response.ok) {
        const detail =
          typeof payload === "object" && payload !== null && "detail" in payload
            ? String(payload.detail)
            : "";
        throw new Error(detail || `System update failed with HTTP ${response.status}.`);
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("armed" in payload) ||
        typeof payload.armed !== "boolean"
      ) {
        throw new Error("The API returned an invalid system status.");
      }
      const nextStatus = payload as SystemStatus;
      setSystemStatus(nextStatus);
      setNotice(
        nextStatus.armed
          ? "Haven is ARMED in software-only mode. No physical hardware was controlled."
          : "Haven is DISARMED in software-only mode. No physical hardware was controlled.",
      );

      const historyResponse = await fetch(`${API_BASE_URL}/api/events`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      });
      if (historyResponse.ok) {
        const history: unknown = await historyResponse.json();
        if (Array.isArray(history)) setEvents(history as SecurityEvent[]);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to update system state.");
    } finally {
      setSystemBusy(false);
    }
  };

  const handleSimulation = async (
    eventType: SimulatedEventType,
    label: string,
  ) => {
    if (!accessToken || simulationBusy) return;
    setSimulationBusy(eventType);
    setNotice("");
    try {
      const response = await fetch(`${API_BASE_URL}/api/simulator/trigger`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ event_type: eventType }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401 || response.status === 403) {
        setAccessToken(null);
        setAuthError("Your session expired. Please sign in again.");
        return;
      }
      if (!response.ok) {
        const detail =
          typeof payload === "object" && payload !== null && "detail" in payload
            ? String(payload.detail)
            : "";
        throw new Error(detail || `Simulation failed with HTTP ${response.status}.`);
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("events_created" in payload) ||
        !Array.isArray(payload.events_created)
      ) {
        throw new Error("The API returned an invalid simulation response.");
      }

      const newEvents = payload.events_created as SecurityEvent[];
      setEvents((previous) => {
        const byId = new Map<string, SecurityEvent>();
        [...newEvents, ...previous].forEach((item) => byId.set(item.id, item));
        return [...byId.values()]
          .sort(
            (a, b) =>
              new Date(b.received_at).getTime() - new Date(a.received_at).getTime(),
          )
          .slice(0, 100);
      });
      setNotice(
        `Simulated ${label.toLowerCase()} saved. ${
          newEvents.length > 1
            ? "Because Haven was armed, a simulated alarm was also logged."
            : "No physical sensor or alarm was activated."
        }`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to create simulated event.");
    } finally {
      setSimulationBusy(null);
    }
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError("");
    setLoginBusy(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: loginUsername.trim(),
          password: loginPassword,
        }),
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const detail =
          typeof payload === "object" && payload !== null && "detail" in payload
            ? String(payload.detail)
            : "";
        if (response.status === 401) {
          throw new Error("Incorrect username or password.");
        }
        throw new Error(detail || `Login failed with HTTP ${response.status}.`);
      }

      if (
        typeof payload !== "object" ||
        payload === null ||
        !("access_token" in payload) ||
        typeof payload.access_token !== "string" ||
        payload.access_token.length === 0
      ) {
        throw new Error("The API returned an invalid login response.");
      }

      setSignedInUsername(loginUsername.trim());
      setLoginPassword("");
      setShowLoginPassword(false);
      setAuthError("");
      setEvents([]);
      setEventsError("");
      setEventsLoading(true);
      setApiStatus("checking");
      setActiveTab("Overview");
      setAccessToken(payload.access_token);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sign-in failed.";
      if (error instanceof TypeError && /fetch/i.test(message)) {
        setAuthError(
          `Cannot reach the Haven API at ${API_BASE_URL}. Start the backend and check its CORS settings.`,
        );
      } else {
        setAuthError(message);
      }
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = () => {
    setAccessToken(null);
    setSignedInUsername("");
    setLoginPassword("");
    setEvents([]);
    setEventsError("");
    setSystemStatus(null);
    setAuthError("");
    setNotice("");
    setAlerts([]);
    seenEventIdsRef.current = null;
    setPushFeedback("");
    setActiveTab("Overview");
    setApiStatus("checking");
  };

  const handleNavigation = (tab: Tab) => {
    setActiveTab(tab);
    setNotice("");
  };

  const apiStatusLabel = {
    checking: "CHECKING API",
    online: "API CONNECTED",
    offline: "API UNAVAILABLE",
  } satisfies Record<ApiStatus, string>;

  if (!accessToken) {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="auth-title">
          <div className="auth-brand">
            <span className="auth-brand-mark" aria-hidden="true">⌂</span>
            <span>
              <strong>Haven</strong>
              <small>HOME SECURITY</small>
            </span>
          </div>

          <p className="auth-eyebrow">PRIVATE HOME SECURITY</p>
          <h1 id="auth-title">Welcome back.</h1>
          <p className="auth-subtitle">
            Sign in to review your home security activity and device events.
          </p>

          <form className="auth-form" onSubmit={handleLogin}>
            <label className="auth-label" htmlFor="haven-username">Username</label>
            <input
              className="auth-input"
              id="haven-username"
              name="username"
              type="text"
              autoComplete="username"
              value={loginUsername}
              onChange={(event) => setLoginUsername(event.target.value)}
              required
              minLength={3}
              maxLength={32}
              disabled={loginBusy}
            />

            <label className="auth-label" htmlFor="haven-password">Password</label>
            <div className="auth-password-field">
              <input
                className="auth-input auth-password-input"
                id="haven-password"
                name="password"
                type={showLoginPassword ? "text" : "password"}
                autoComplete="current-password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                required
                disabled={loginBusy}
              />
              <button
                className="auth-password-toggle"
                type="button"
                aria-label={showLoginPassword ? "Hide password" : "Show password"}
                aria-pressed={showLoginPassword}
                onClick={() => setShowLoginPassword((visible) => !visible)}
                disabled={loginBusy}
              >
                {showLoginPassword ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M3 3l18 18" />
                    <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                    <path d="M9.9 5.2A11.8 11.8 0 0 1 12 5c5 0 8.5 4.2 9.5 7-.4 1.1-1.2 2.4-2.4 3.5" />
                    <path d="M6.2 6.2C3.9 7.7 2.7 10 2.5 12c1 2.8 4.5 7 9.5 7 1.2 0 2.4-.3 3.4-.7" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>

            {authError && (
              <p className="auth-error" role="alert">{authError}</p>
            )}

            <button className="auth-submit" type="submit" disabled={loginBusy}>
              {loginBusy ? "Signing in…" : "Sign in securely"}
              <span aria-hidden="true">→</span>
            </button>
          </form>

          <p className="auth-hint">
            Your session token stays in memory and is cleared when you refresh
            the page or sign out.
          </p>
          <p className="auth-api-line">API: {API_BASE_URL}</p>
        </section>
        <p className="auth-footer">HAVEN · PERSONAL HOME SECURITY</p>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#home"
          onClick={(event) => {
            event.preventDefault();
            handleNavigation("Overview");
          }}
          aria-label="Haven home"
        >
          <span className="brand-mark" aria-hidden="true">
            ⌂
          </span>
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
              type="button"
              className={`nav-item ${activeTab === item.name ? "active" : ""}`}
              aria-current={activeTab === item.name ? "page" : undefined}
              onClick={() => handleNavigation(item.name)}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>{item.name}</span>
              {item.name === "Events" && (
                <span className="nav-count">{events.length}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="connection-card">
            <span className="connection-dot" />
            <div>
              <strong>ESP32 offline</strong>
              <small>Hardware integration pending</small>
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
          <div className="topbar-actions">
            <span className={`mode-badge api-${apiStatus}`}>
              <span className="status-dot" />
              {apiStatusLabel[apiStatus]}
            </span>
            <div className="account-actions">
              <span className="signed-in-label">{signedInUsername}</span>
              <button type="button" className="logout-button" onClick={handleLogout}>
                Sign out <span aria-hidden="true">↗</span>
              </button>
            </div>
          </div>
        </header>

        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button
              type="button"
              onClick={() => setNotice("")}
              aria-label="Dismiss message"
            >
              ×
            </button>
          </div>
        )}

        {alerts.length > 0 && (
          <div className="live-alert-stack" aria-label="New security alerts">
            {alerts.map((alert) => (
              <div
                className={`live-alert ${alert.event_type === "alarm_triggered" ? "live-alert-critical" : ""}`}
                key={alert.id}
                role={alert.event_type === "alarm_triggered" ? "alert" : "status"}
              >
                <span className="live-alert-mark" aria-hidden="true">{eventSymbols[alert.event_type]}</span>
                <div className="live-alert-copy">
                  <strong>{eventLabels[alert.event_type]}</strong>
                  <p>{alert.message}</p>
                </div>
                <button type="button" onClick={() => setAlerts((previous) => previous.filter((item) => item.id !== alert.id))} aria-label="Dismiss alert">×</button>
              </div>
            ))}
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
              <span className="preview-chip">DEVELOPMENT PREVIEW</span>
            </section>

            <section className="hero-card">
              <div className="hero-copy">
                <div className="hero-status">
                  <span className="hero-status-dot" />
                  {!systemStatus
                    ? "LOADING SYSTEM STATE"
                    : systemStatus.armed
                      ? "ARMED · SOFTWARE MODE"
                      : "DISARMED · SOFTWARE MODE"}
                </div>

                <h2>
                  {!systemStatus
                    ? "Checking system state…"
                    : systemStatus.armed
                      ? "Haven is armed."
                      : "System standing by."}
                </h2>

                <p>
                  {systemStatus?.armed
                    ? "Software state is armed. Simulated motion or door events will also create a simulated alarm event."
                    : "Arm Haven to test intrusion handling in software. Your physical sensors and alarm are not connected."}
                </p>

                <button
                  type="button"
                  className={`primary-button ${systemStatus?.armed ? "disarm-button" : ""}`}
                  onClick={() => void handleSystemToggle()}
                  disabled={!systemStatus || systemBusy}
                >
                  <span aria-hidden="true">{systemBusy ? "…" : systemStatus?.armed ? "Ⅱ" : "↗"}</span>
                  {systemBusy
                    ? "Updating…"
                    : systemStatus?.armed
                      ? "Disarm system"
                      : "Arm system"}
                </button>

                <small className="hero-disclaimer">
                  Software-only control · Does not control physical hardware
                </small>
              </div>

              <div className="hero-visual" aria-hidden="true">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="shield">
                  <svg viewBox="0 0 100 112" className="shield-svg">
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

            <section className="section simulator-panel">
              <div className="section-heading">
                <div>
                  <h2>Software simulator</h2>
                  <p>Generate test events without connecting any hardware.</p>
                </div>
                <span className="simulation-badge">SIMULATION</span>
              </div>
              <p className="simulator-description">
                Every test is saved to your event history with a SIMULATED label.
                When Haven is armed, simulated motion or door-opening events also
                log a simulated alarm. No physical sensor or buzzer is activated.
              </p>
              <div className="simulation-actions">
                <button
                  className="simulation-button"
                  type="button"
                  disabled={apiStatus !== "online" || simulationBusy !== null}
                  onClick={() => void handleSimulation("motion_detected", "Motion detected")}
                >
                  {simulationBusy === "motion_detected" ? "Recording…" : "↗ Simulate motion"}
                </button>
                <button
                  className="simulation-button"
                  type="button"
                  disabled={apiStatus !== "online" || simulationBusy !== null}
                  onClick={() => void handleSimulation("door_opened", "Door opened")}
                >
                  {simulationBusy === "door_opened" ? "Recording…" : "⌂ Simulate door"}
                </button>
                <button
                  className="simulation-button"
                  type="button"
                  disabled={apiStatus !== "online" || simulationBusy !== null}
                  onClick={() => void handleSimulation("alarm_triggered", "Alarm triggered")}
                >
                  {simulationBusy === "alarm_triggered" ? "Recording…" : "! Test alarm event"}
                </button>
                <button
                  className="simulation-button"
                  type="button"
                  disabled={apiStatus !== "online" || simulationBusy !== null}
                  onClick={() => void handleSimulation("device_online", "Device online")}
                >
                  {simulationBusy === "device_online" ? "Recording…" : "+ Simulate device online"}
                </button>
                <button
                  className="simulation-button secondary-simulation"
                  type="button"
                  disabled={apiStatus !== "online" || simulationBusy !== null}
                  onClick={() => void handleSimulation("device_offline", "Device offline")}
                >
                  {simulationBusy === "device_offline" ? "Recording…" : "− Simulate device offline"}
                </button>
              </div>
            </section>

            <section className="section">
              <div className="section-heading">
                <div>
                  <h2>Security devices</h2>
                  <p>Hardware readiness at a glance.</p>
                </div>
                <span className="count-badge">0 / {devices.length} ONLINE</span>
              </div>

              <div className="device-grid">
                {devices.map((device) => (
                  <article className="device-card" key={device.name}>
                    <div className="device-card-top">
                      <span className="device-icon" aria-hidden="true">
                        {device.icon}
                      </span>
                      <span className="offline-pill">OFFLINE</span>
                    </div>
                    <h3>{device.name}</h3>
                    <p className="device-detail">{device.detail}</p>
                    <div className="device-divider" />
                    <p className="device-status">
                      <span className="status-dot" />
                      Awaiting connection
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
                    <p>Latest events returned by the API.</p>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => handleNavigation("Events")}
                  >
                    View history →
                  </button>
                </div>

                {eventsLoading ? (
                  <div className="empty-state" role="status">
                    <strong>Loading activity…</strong>
                  </div>
                ) : eventsError ? (
                  <div className="empty-state">
                    <span className="empty-icon" aria-hidden="true">!</span>
                    <strong>Backend unavailable</strong>
                    <p>{eventsError}</p>
                    <p>Start FastAPI locally to load development events.</p>
                  </div>
                ) : (
                  <EventList events={events.slice(0, 4)} />
                )}
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
                    <p>Hardware connection is the next stage; software simulation is ready now.</p>
                  </div>
                </div>
                <div className="setup-row">
                  <span className="setup-number">02</span>
                  <div>
                    <strong>Enable notifications</strong>
                    <p>Configure browser push in Settings; new events appear here as in-app alerts.</p>
                  </div>
                </div>
                <div className="setup-row">
                  <span className="setup-number">03</span>
                  <div>
                    <strong>Connect the camera</strong>
                    <p>Add your ESP32-CAM live feed securely.</p>
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
              Events returned by the Haven API. Earlier Swagger test entries may be simulated, not physical sensor detections.
            </p>

            {eventsLoading ? (
              <div className="empty-state large-empty" role="status">
                <strong>Loading events…</strong>
              </div>
            ) : eventsError ? (
              <div className="empty-state large-empty">
                <span className="empty-icon" aria-hidden="true">!</span>
                <strong>Unable to load event history</strong>
                <p>{eventsError}</p>
              </div>
            ) : (
              <EventList events={events} />
            )}

            <div className="event-page-footer">
              <span>{events.length} event{events.length === 1 ? "" : "s"} returned</span>
              <span>Refreshes every 5 seconds</span>
            </div>
          </section>
        )}

        {activeTab === "Camera" && (
          <section className="standalone-panel">
            <p className="eyebrow">VISUAL MONITORING</p>
            <h1>Security camera</h1>
            <p className="page-subtitle">
              Your camera stream will be shown here when the camera is connected.
            </p>
            <div className="camera-placeholder">
              <span className="camera-symbol" aria-hidden="true">▧</span>
              <h2>Camera not connected</h2>
              <p>
                The ESP32-CAM stream will appear here after camera setup,
                network configuration and secure access are implemented.
              </p>
            </div>
          </section>
        )}

        {activeTab === "Settings" && (
          <section className="standalone-panel">
            <p className="eyebrow">CONFIGURATION</p>
            <h1>Settings</h1>
            <p className="page-subtitle">
              Current development configuration.
            </p>
            <div className="settings-card">
              <div>
                <strong>Controller</strong>
                <p>ESP32 DevKit · planned GPIO27 motion input</p>
              </div>
              <span className="offline-pill">NOT CONNECTED</span>
            </div>
            <div className="settings-card">
              <div>
                <strong>Backend API</strong>
                <p>{API_BASE_URL}</p>
              </div>
              <span className={`offline-pill api-pill-${apiStatus}`}>
                {apiStatusLabel[apiStatus]}
              </span>
            </div>
            <div className="settings-card settings-notification-card">
              <div className="notification-copy">
                <strong>Browser push notifications</strong>
                <p>Receive new Haven security events outside the dashboard. This requires a supported browser, permission, VAPID setup, and an active internet connection.</p>
                <div className="push-settings-actions">
                  <button className="simulation-button" type="button" onClick={() => void handleEnablePush()} disabled={pushBusy || !pushStatus.configured}>
                    {pushBusy ? "Working…" : pushStatus.subscribed ? "Refresh subscription" : "Enable push"}
                  </button>
                  <button className="simulation-button" type="button" onClick={() => void handleTestPush()} disabled={pushBusy || !pushStatus.subscribed}>
                    Send test notification
                  </button>
                  <button className="simulation-button secondary-simulation" type="button" onClick={() => void handleDisablePush()} disabled={pushBusy || !pushStatus.subscribed}>
                    Disable push
                  </button>
                </div>
                {pushFeedback && <p className="push-feedback" role="status">{pushFeedback}</p>}
                {!pushStatus.configured && (
                  <p className="push-feedback">Setup required: install pywebpush and generate the server's VAPID keys using the included instructions.</p>
                )}
              </div>
              <span className={`offline-pill ${pushStatus.subscribed ? "push-pill-enabled" : ""}`}>
                {pushStatus.subscribed ? "ENABLED" : pushStatus.configured ? "READY" : "SETUP REQUIRED"}
              </span>
            </div>
            <div className="settings-card">
              <div>
                <strong>Application</strong>
                <p>Haven Home Security · Progressive Web App</p>
              </div>
              <span className="offline-pill">PWA</span>
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
