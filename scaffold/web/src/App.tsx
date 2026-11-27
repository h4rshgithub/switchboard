import { useCallback, useEffect, useRef, useState } from 'react';

interface WorkspaceMembership {
  id: string;
  role: string;
}

interface User {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceMembership[];
}

interface Conversation {
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  last_activity_at: string;
  last_message_preview: string;
}

interface Message {
  id: string;
  client_ref?: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status: string;
  timestamp: string;
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<string>('');
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [totalConvs, setTotalConvs] = useState(0);
  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [wsLive, setWsLive] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const lastSeqRef = useRef<number>(0);
  const selectedContactRef = useRef<string | null>(null);
  selectedContactRef.current = selectedContact;

  useEffect(() => {
    fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: User | null) => {
        setUser(data);
        if (data && data.workspaces.length > 0) {
          setWorkspace(data.workspaces[0].id);
        }
      })
      .catch(() => setUser(null));
  }, []);

  const loadConversations = useCallback(
    async (ws: string, statusFilter: string, limit = 50) => {
      if (!ws) return;
      const res = await fetch(
        `/api/conversations?workspace=${encodeURIComponent(ws)}&status=${statusFilter}&limit=${limit}`
      );
      if (res.ok) {
        const data = (await res.json()) as { conversations: Conversation[]; total: number };
        setConversations(data.conversations);
        setTotalConvs(data.total);
      }
    },
    []
  );

  const loadMessages = useCallback(async (ws: string, contact: string) => {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(contact)}/messages?workspace=${encodeURIComponent(ws)}`
    );
    if (res.ok) {
      const data = (await res.json()) as { messages: Message[] };
      setMessages(data.messages);
    }
  }, []);

  useEffect(() => {
    if (!workspace) return;
    setSelectedContact(null);
    setMessages([]);
    lastSeqRef.current = 0;
    void loadConversations(workspace, filter);
  }, [workspace, filter, loadConversations]);

  useEffect(() => {
    if (!workspace || !selectedContact) {
      setMessages([]);
      return;
    }
    setErrorMsg(null);
    void loadMessages(workspace, selectedContact);
  }, [workspace, selectedContact, loadMessages]);

  // Real-time WebSocket with automatic reconnect & ?after=seq replay
  useEffect(() => {
    if (!workspace || !user) return;
    let closed = false;
    let ws: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const after = lastSeqRef.current > 0 ? `&after=${lastSeqRef.current}` : '';
      ws = new WebSocket(`${proto}//${window.location.host}/ws?workspace=${encodeURIComponent(workspace)}${after}`);

      ws.onopen = () => setWsLive(true);
      ws.onclose = () => {
        setWsLive(false);
        if (!closed) {
          retryTimer = setTimeout(connect, 1500);
        }
      };
      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (typeof frame.seq === 'number' && frame.seq > lastSeqRef.current) {
            lastSeqRef.current = frame.seq;
          }
          const type = String(frame.type || '');
          const contact = String(frame.contact || '');

          if (type === 'message.inbound') {
            const msgId = String(frame.message_id || '');
            const text = String(frame.text || '');
            const occurredAt = String(frame.occurred_at || new Date().toISOString());

            setConversations((prev) => {
              const existing = prev.find((c) => c.contact === contact);
              const updated: Conversation = existing
                ? { ...existing, last_activity_at: occurredAt, last_message_preview: text }
                : { contact, assignee: null, status: 'open', last_activity_at: occurredAt, last_message_preview: text };
              return [updated, ...prev.filter((c) => c.contact !== contact)];
            });

            if (selectedContactRef.current === contact) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === msgId)) return prev;
                return [...prev, { id: msgId, direction: 'inbound', text, status: 'received', timestamp: occurredAt }];
              });
            }
          } else if (type === 'message.outbound') {
            const clientRef = String(frame.client_ref || '');
            const text = String(frame.text || '');
            const status = String(frame.status || 'queued');
            const createdAt = String(frame.created_at || new Date().toISOString());

            setConversations((prev) => {
              const existing = prev.find((c) => c.contact === contact);
              const updated: Conversation = existing
                ? { ...existing, last_activity_at: createdAt, last_message_preview: text }
                : { contact, assignee: null, status: 'open', last_activity_at: createdAt, last_message_preview: text };
              return [updated, ...prev.filter((c) => c.contact !== contact)];
            });

            if (selectedContactRef.current === contact) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === clientRef || m.client_ref === clientRef)) return prev;
                return [...prev, { id: clientRef, client_ref: clientRef, direction: 'outbound', text, status, timestamp: createdAt }];
              });
            }
          } else if (type === 'message.status') {
            const clientRef = String(frame.client_ref || '');
            const status = String(frame.status || '');
            if (selectedContactRef.current === contact) {
              setMessages((prev) =>
                prev.map((m) => (m.client_ref === clientRef || m.id === clientRef ? { ...m, status } : m))
              );
            }
          } else if (type === 'conversation.assigned') {
            const assignee = (frame.assignee as string | null) ?? null;
            setConversations((prev) => prev.map((c) => (c.contact === contact ? { ...c, assignee } : c)));
          } else if (type === 'conversation.updated') {
            const status = frame.status as 'open' | 'closed';
            setConversations((prev) => prev.map((c) => (c.contact === contact ? { ...c, status } : c)));
          }
        } catch {
          // ignore
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, [workspace, user]);

  const activeConv = conversations.find((c) => c.contact === selectedContact) ?? null;

  const handleSend = async () => {
    if (!workspace || !selectedContact || !draft.trim() || sending) return;
    setSending(true);
    setErrorMsg(null);
    const clientRef = `ui_${crypto.randomUUID()}`;
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(selectedContact)}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, text: draft.trim(), client_ref: clientRef }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(body.error || `Failed to send (${res.status})`);
      } else {
        setDraft('');
      }
    } finally {
      setSending(false);
    }
  };

  const handleClaim = async () => {
    if (!workspace || !selectedContact) return;
    setErrorMsg(null);
    const res = await fetch(`/api/conversations/${encodeURIComponent(selectedContact)}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace }),
    });
    if (res.status === 409) {
      setErrorMsg('Another agent already claimed this conversation.');
      void loadConversations(workspace, filter);
    } else if (!res.ok) {
      setErrorMsg(`Claim failed (${res.status})`);
    }
  };

  const handleUnclaim = async () => {
    if (!workspace || !selectedContact) return;
    setErrorMsg(null);
    const res = await fetch(`/api/conversations/${encodeURIComponent(selectedContact)}/unclaim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setErrorMsg(body.error || `Release failed (${res.status})`);
    }
  };

  const handleToggleStatus = async () => {
    if (!workspace || !activeConv) return;
    const next = activeConv.status === 'closed' ? 'open' : 'closed';
    await fetch(`/api/conversations/${encodeURIComponent(activeConv.contact)}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, status: next }),
    });
  };

  const handleLogout = async () => {
    await fetch('/auth/logout', { method: 'POST' });
    setUser(null);
  };

  if (user === undefined) {
    return <div className="login-shell">Loading Switchboard…</div>;
  }

  if (user === null) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h1>Switchboard</h1>
          <p>Shared team inbox for customer support</p>
          <a className="btn btn-primary" href="/auth/login">
            Sign in with Mock IdP
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">Switchboard</span>
          <select
            className="ws-select"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            {user.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} ({w.role})
              </option>
            ))}
          </select>
          <span className="ws-status">
            <span className={`dot ${wsLive ? 'live' : ''}`} />
            {wsLive ? 'Live' : 'Reconnecting'}
          </span>
        </div>
        <div className="topbar-right">
          <span>{user.name || user.sub}</span>
          <button className="btn" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      <div className="main-grid">
        <aside className="sidebar">
          <div className="filter-bar">
            {(['all', 'open', 'closed'] as const).map((tab) => (
              <button
                key={tab}
                className={`filter-tab ${filter === tab ? 'active' : ''}`}
                onClick={() => setFilter(tab)}
              >
                {tab[0].toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
          <div className="conv-list">
            {conversations.length === 0 ? (
              <div className="empty-state">No conversations yet</div>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.contact}
                  className={`conv-item ${selectedContact === c.contact ? 'selected' : ''}`}
                  onClick={() => setSelectedContact(c.contact)}
                >
                  <div className="conv-top">
                    <span className="conv-contact">{c.contact}</span>
                    {c.status === 'closed' && <span className="badge badge-closed">closed</span>}
                  </div>
                  <div className="conv-preview">{c.last_message_preview || 'No messages'}</div>
                  <div className="conv-meta">
                    <span
                      className={`badge ${
                        c.assignee === user.sub
                          ? 'badge-mine'
                          : c.assignee
                          ? 'badge-other'
                          : ''
                      }`}
                    >
                      {c.assignee === user.sub ? 'Claimed by you' : c.assignee || 'Unassigned'}
                    </span>
                  </div>
                </div>
              ))
            )}
            {conversations.length < totalConvs && (
              <div style={{ padding: 12, textAlign: 'center' }}>
                <button
                  className="btn"
                  onClick={() => void loadConversations(workspace, filter, conversations.length + 50)}
                >
                  Load more ({totalConvs - conversations.length} remaining)
                </button>
              </div>
            )}
          </div>
        </aside>

        <section className="thread-pane">
          {!selectedContact ? (
            <div className="empty-state">Select a conversation to view messages</div>
          ) : (
            <>
              <div className="thread-header">
                <div>
                  <strong>{selectedContact}</strong>{' '}
                  {activeConv?.status === 'closed' && <span className="badge badge-closed">Closed</span>}
                </div>
                <div className="thread-actions">
                  {!activeConv?.assignee && (
                    <button className="btn btn-primary" onClick={handleClaim}>
                      Claim
                    </button>
                  )}
                  {activeConv?.assignee === user.sub && (
                    <button className="btn" onClick={handleUnclaim}>
                      Release
                    </button>
                  )}
                  {activeConv?.assignee && activeConv.assignee !== user.sub && (
                    <span className="badge badge-other">Held by {activeConv.assignee}</span>
                  )}
                  <button className="btn" onClick={handleToggleStatus}>
                    {activeConv?.status === 'closed' ? 'Reopen' : 'Close'}
                  </button>
                </div>
              </div>

              {errorMsg && <div className="error-banner">{errorMsg}</div>}

              <div className="messages-scroll">
                {messages.map((m) => (
                  <div key={m.id} className={`msg-row ${m.direction}`}>
                    <div className="msg-bubble">{m.text}</div>
                    <div className="msg-meta">
                      {new Date(m.timestamp).toLocaleTimeString()}
                      {m.direction === 'outbound' ? ` · ${m.status}` : ''}
                    </div>
                  </div>
                ))}
              </div>

              <div className="composer">
                <textarea
                  placeholder="Write a reply…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                />
                <button
                  className="btn btn-primary"
                  disabled={sending || !draft.trim()}
                  onClick={() => void handleSend()}
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
