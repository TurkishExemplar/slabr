import React, { createContext, useContext, useState, useEffect } from 'react';
import { API } from '../lib/api';

const AuthContext = createContext(null);

const TOKEN_KEY = 'slabr_token';
const USER_KEY  = 'slabr_user';

export function AuthProvider({ children }) {
  const [user,  setUser]  = useState(null);
  const [token, setToken] = useState(null);
  const [ready, setReady] = useState(false); // true once we've checked localStorage

  // Restore session from localStorage on first load
  useEffect(() => {
    const storedToken = localStorage.getItem(TOKEN_KEY);
    const storedUser  = localStorage.getItem(USER_KEY);

    if (!storedToken) {
      setReady(true);
      return;
    }

    // Optimistically restore state, then validate with the server
    try {
      const parsedUser = JSON.parse(storedUser ?? 'null');
      setToken(storedToken);
      setUser(parsedUser);
    } catch {
      // corrupt data — clear it
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      setReady(true);
      return;
    }

    // Verify the token is still valid
    fetch(`${API}/api/auth/me`, {
      headers: { Authorization: `Bearer ${storedToken}` },
    })
      .then(r => {
        if (!r.ok) throw new Error('Token invalid');
        return r.json();
      })
      .then(freshUser => {
        setUser(freshUser);
        localStorage.setItem(USER_KEY, JSON.stringify(freshUser));
      })
      .catch(() => {
        // Token expired or revoked — clear everything
        setToken(null);
        setUser(null);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      })
      .finally(() => setReady(true));
  }, []);

  function login(newToken, newUser) {
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
  }

  function logout() {
    setToken(null);
    setUser(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  // Don't render children until we've resolved the stored session —
  // prevents a flash of the login page for authenticated users.
  if (!ready) return null;

  return (
    <AuthContext.Provider value={{ user, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
