"""MCP client for the Adhvaga test runner (Trip, Metro and Buses servers).

Starts the Trip server over stdio in TEST MODE (in-memory database), so each call can choose its
role (public / agent / user), its browser session and injected faults through the request _meta.
"""
from __future__ import annotations

import json
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[2]
TRIP_SERVER = ROOT / "servers" / "trip" / "src" / "server.ts"
METRO_SERVER = ROOT / "servers" / "metro" / "src" / "server.ts"
BUSES_SERVER = ROOT / "servers" / "buses" / "src" / "server.ts"
ENVELOPE_KEYS = {"status", "source", "label", "retrieved_at", "data_as_of", "confidence", "data", "error"}


class TripClient:
    def __init__(self, session: ClientSession, tools: list[Any]):
        self.session = session
        self.tools = tools
        self.tool_names = [t.name for t in tools]
        self.write_tools = {t.name for t in tools if (t.description or "").startswith("[CHANGES")}

    async def call(self, tool: str, args: dict[str, Any], *, role: str, session: str, faults: dict | None = None) -> dict:
        if tool in self.write_tools and "idempotency_key" not in args:
            args = {"idempotency_key": str(uuid.uuid4()), **args}
        meta: dict[str, Any] = {"adhvaga_role": role, "adhvaga_session": session}
        if faults:
            meta["adhvaga_faults"] = faults
        r = await self.session.call_tool(tool, args, meta=meta)
        text = r.content[0].text if getattr(r, "content", None) else ""
        try:
            env = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            # Wrong input SHAPE is refused by the MCP library before the server code runs.
            env = {"status": "error", "source": "mcp", "label": "unavailable", "retrieved_at": None, "data_as_of": None,
                   "confidence": {"level": "low", "reasons": ["mcp input error"]}, "data": None,
                   "error": {"code": "BAD_INPUT", "message": text[:300]}, "_mcp_level": True}
        return env


@asynccontextmanager
async def trip_server():
    params = StdioServerParameters(
        command="node",
        args=[str(TRIP_SERVER)],
        env={**os.environ, "ADHVAGA_TEST_MODE": "1", "ADHVAGA_STDIO_ROLE": "public"},
        cwd=str(TRIP_SERVER.parent.parent),
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = (await session.list_tools()).tools
            yield TripClient(session, tools)

class MultiClient:
    """Sends each tool call to the server that owns that tool (Trip or Metro)."""

    def __init__(self, clients: list[TripClient]):
        self.owner: dict[str, TripClient] = {}
        for c in clients:
            for n in c.tool_names:
                if n in self.owner:
                    raise RuntimeError(f"tool {n} exists on two servers")
                self.owner[n] = c
        self.tool_names = list(self.owner)
        self.write_tools = set().union(*(c.write_tools for c in clients))

    async def call(self, tool: str, args: dict[str, Any], *, role: str, session: str, faults: dict | None = None) -> dict:
        if tool not in self.owner:
            raise KeyError(f"no server has tool {tool}")
        return await self.owner[tool].call(tool, args, role=role, session=session, faults=faults)


@asynccontextmanager
async def read_only_server(path: Path):
    params = StdioServerParameters(command="node", args=[str(path)], env={**os.environ}, cwd=str(path.parent.parent))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = (await session.list_tools()).tools
            yield TripClient(session, tools)


@asynccontextmanager
async def all_servers():
    async with trip_server() as trip, read_only_server(METRO_SERVER) as metro, read_only_server(BUSES_SERVER) as buses:
        yield MultiClient([trip, metro, buses])
