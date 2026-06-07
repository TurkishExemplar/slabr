import React from 'react';
import { Link, useNavigate } from 'react-router-dom';

export default function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#09090b] flex items-center justify-center px-4">
      <div className="text-center space-y-6 max-w-sm">
        {/* Logo */}
        <div className="flex items-center gap-3 justify-center mb-2">
          <div className="w-9 h-9 rounded-xl bg-indigo-500 flex items-center justify-center">
            <span className="text-white font-bold">S</span>
          </div>
          <span className="text-white text-xl font-bold tracking-tight">Slabr</span>
        </div>

        <div>
          <p className="text-zinc-700 text-8xl font-black tracking-tight select-none">404</p>
          <h1 className="text-white text-xl font-semibold mt-2">Page not found</h1>
          <p className="text-zinc-500 text-sm mt-2">
            This page doesn't exist or was moved.
          </p>
        </div>

        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 text-sm transition"
          >
            Go back
          </button>
          <Link
            to="/dashboard"
            className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium transition"
          >
            Portfolio
          </Link>
        </div>
      </div>
    </div>
  );
}
