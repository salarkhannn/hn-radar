import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);

const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || "";
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || "";

let redditAccessToken: string | null = null;
let tokenExpiresAt = 0;

async function getRedditToken(): Promise<string> {
  if (redditAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return redditAccessToken;
  }
  const credentials = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "poke-hn-radar/1.0",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json() as { access_token: string; expires_in: number };
  redditAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return redditAccessToken;
}

interface HNStory {
  title: string;
  url: string;
  score: number;
  descendants: number;
}

interface AlgoliaHit {
  title: string;
  url: string;
  points: number;
  num_comments: number;
  objectID: string;
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
}

interface RedditPost {
  title: string;
  url: string;
  score: number;
  num_comments: number;
}

interface RedditChild {
  data: RedditPost;
}

interface RedditListing {
  children: RedditChild[];
}

interface RedditOAuthResponse {
  data: RedditListing;
}

async function getTopStories() {
  const response = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  const storyIds: number[] = await response.json();
  const top10 = storyIds.slice(0, 10);
  const stories = await Promise.all(
    top10.map(async (id: number) => {
      const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      const item: HNStory = await itemRes.json();
      return {
        title: item.title,
        url: item.url || `https://news.ycombinator.com/item?id=${id}`,
        score: item.score,
        commentCount: item.descendants || 0,
      };
    })
  );
  return stories;
}

async function searchHN(query: string) {
  const response = await fetch(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story`
  );
  const data: AlgoliaResponse = await response.json();
  return (data.hits || []).slice(0, 5).map((hit) => ({
    title: hit.title,
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    points: hit.points || 0,
    numComments: hit.num_comments || 0,
  }));
}

async function getRedditTrending(subreddit: string) {
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) {
    return [];
  }
  const token = await getRedditToken();
  const response = await fetch(
    `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/hot?limit=5`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "poke-hn-radar/1.0",
      },
    }
  );
  const data: RedditOAuthResponse = await response.json();
  return (data.data?.children || []).map((child) => ({
    title: child.data.title,
    url: child.data.url,
    score: child.data.score,
    commentCount: child.data.num_comments,
  }));
}

const tools = [
  {
    name: "get_top_stories",
    description:
      "Fetches the current top 10 stories from Hacker News via the official Firebase API. Returns title, URL, score, and comment count for each story. No auth needed.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "search_hn",
    description:
      "Searches Hacker News stories using the Algolia HN Search API. Returns the top 5 results with title, URL, points, and num_comments.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query string",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_reddit_trending",
    description:
      "Fetches the top 5 hot posts from a subreddit via the Reddit OAuth API. Requires REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET env vars. Returns title, URL, score, and comment count.",
    inputSchema: {
      type: "object",
      properties: {
        subreddit: {
          type: "string",
          description: "Subreddit name (default: 'programming')",
        },
      },
    },
  },
];

async function handleToolCall(name: string, args: Record<string, unknown> | undefined) {
  switch (name) {
    case "get_top_stories": {
      const stories = await getTopStories();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(stories, null, 2) }],
      };
    }

    case "search_hn": {
      const query = args?.query as string;
      if (!query) {
        return {
          content: [{ type: "text" as const, text: "Error: 'query' parameter is required" }],
          isError: true,
        };
      }
      const results = await searchHN(query);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    }

    case "get_reddit_trending": {
      const subreddit = (args?.subreddit as string) || "programming";
      if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) {
        return {
          content: [{ type: "text" as const, text: "Reddit API credentials not configured. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET environment variables. Create a script app at https://www.reddit.com/prefs/apps" }],
          isError: true,
        };
      }
      const posts = await getRedditTrending(subreddit);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(posts, null, 2) }],
      };
    }

    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

function setupHandlers(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handleToolCall(request.params.name, request.params.arguments);
  });
}

const sessions = new Map<string, SSEServerTransport>();

async function main() {
  const sseServer = new Server(
    { name: "hn-radar", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  setupHandlers(sseServer);

  const httpServer = new Server(
    { name: "hn-radar", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  setupHandlers(httpServer);

  const httpTransport = new StreamableHTTPServerTransport();
  httpServer.connect(httpTransport);

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    sessions.set(transport.sessionId, transport);
    res.on("close", () => sessions.delete(transport.sessionId));
    await sseServer.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  app.post("/mcp", async (req, res) => {
    await httpTransport.handleRequest(req, res);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.listen(port, () => {
    console.log(`hn-radar MCP server listening on port ${port}`);
  });
}

main().catch(console.error);
