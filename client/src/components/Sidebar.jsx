import { useState } from "preact/hooks";
import { Button, IconButton } from "./ui";

export function Sidebar({
  sessions,
  currentSessionId,
  onSessionSelect,
  onNewSession,
  onDeleteSession,
  isMobileOpen,
  onMobileClose,
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Group sessions by time period
  const groupSessions = () => {
    const now = new Date();
    const today = [];
    const yesterday = [];
    const older = [];

    sessions.forEach((session) => {
      if (!session.createdAt) {
        today.push(session);
        return;
      }
      const sessionDate = new Date(session.createdAt);
      const diffTime = Math.abs(now - sessionDate);
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        today.push(session);
      } else if (diffDays === 1) {
        yesterday.push(session);
      } else {
        older.push(session);
      }
    });

    return { today, yesterday, older };
  };

  const { today, yesterday, older } = groupSessions();

  return (
    <div
      className={`sidebar ${isCollapsed ? "collapsed" : ""} ${isMobileOpen ? "open" : ""}`}
    >
      <div className="sidebar-header">
        {!isCollapsed && (
          <>
            <div className="sidebar-branding">
              <div className="sidebar-logo">
                <div className="logo-icon"></div>
                <div className="logo-text">
                  <span className="logo-agents">dAIbetes</span>
                </div>
              </div>
              <div className="sidebar-header-actions">
                {/* Close button for mobile */}
                <IconButton
                  icon="close"
                  onClick={onMobileClose}
                  title="Close menu"
                  variant="ghost"
                  className="mobile-close-btn"
                />
                {/* Collapse button for desktop */}
                <IconButton
                  icon="chevronLeft"
                  onClick={() => setIsCollapsed(!isCollapsed)}
                  title="Collapse sidebar"
                  variant="ghost"
                  className="toggle-sidebar-btn"
                />
              </div>
            </div>
            <Button
              variant="ghost"
              icon="search"
              title="Search chats"
              className="sidebar-search-btn"
            >
              <span>Search chats</span>
              <kbd className="kbd">⌘K</kbd>
            </Button>
            <Button
              variant="secondary"
              icon="plus"
              onClick={onNewSession}
              className="new-session-btn"
            >
              New Chat
            </Button>
          </>
        )}
        {isCollapsed && (
          <IconButton
            icon="chevronRight"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title="Expand sidebar"
            variant="ghost"
            className="toggle-sidebar-btn"
            style={{ margin: "0 auto" }}
          />
        )}
      </div>

      {!isCollapsed && (
        <>
          <div className="sessions-list">
            {today.length > 0 && (
              <>
                <div className="sessions-list-header">Today</div>
                {today.map((session) => (
                  <div
                    key={session.id}
                    className={`session-item ${session.id === currentSessionId ? "active" : ""}`}
                    onClick={() => onSessionSelect(session.id)}
                  >
                    <div className="session-info">
                      <span className="session-title">
                        {session.title || "New conversation"}
                      </span>
                    </div>
                    <IconButton
                      icon="close"
                      size={14}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                      }}
                      title="Delete session"
                      variant="ghost"
                      className="delete-session-btn"
                    />
                  </div>
                ))}
              </>
            )}

            {yesterday.length > 0 && (
              <>
                <div className="sessions-list-header">Yesterday</div>
                {yesterday.map((session) => (
                  <div
                    key={session.id}
                    className={`session-item ${session.id === currentSessionId ? "active" : ""}`}
                    onClick={() => onSessionSelect(session.id)}
                  >
                    <div className="session-info">
                      <span className="session-title">
                        {session.title || "New conversation"}
                      </span>
                    </div>
                    <IconButton
                      icon="close"
                      size={14}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                      }}
                      title="Delete session"
                      variant="ghost"
                      className="delete-session-btn"
                    />
                  </div>
                ))}
              </>
            )}

            {older.length > 0 && (
              <>
                <div className="sessions-list-header">Previous</div>
                {older.map((session) => (
                  <div
                    key={session.id}
                    className={`session-item ${session.id === currentSessionId ? "active" : ""}`}
                    onClick={() => onSessionSelect(session.id)}
                  >
                    <div className="session-info">
                      <span className="session-title">
                        {session.title || "New conversation"}
                      </span>
                    </div>
                    <IconButton
                      icon="close"
                      size={14}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                      }}
                      title="Delete session"
                      variant="ghost"
                      className="delete-session-btn"
                    />
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="sidebar-footer">
            <Button
              variant="ghost"
              icon="logout"
              onClick={async () => {
                try {
                  await fetch("/api/auth/logout", {
                    method: "POST",
                    credentials: "include",
                  });
                  // Reload to show login screen
                  window.location.reload();
                } catch (error) {
                  console.error("Logout failed:", error);
                }
              }}
              className="sidebar-logout-btn"
              title="Logout"
            >
              Logout
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
