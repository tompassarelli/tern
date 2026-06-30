defmodule TernWeb.Router do
  use TernWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {TernWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", TernWeb do
    pipe_through :api

    get "/dag", ApiController, :dag
    get "/list", ApiController, :list
    get "/board", ApiController, :board
    get "/agents", ApiController, :agents
    get "/agents/:handle/stream", ApiController, :agent_stream
    get "/presence", ApiController, :presence
    get "/entities", ApiController, :entities
    # wake derives the feed's WS as a sibling of the feed URL (/api/entities → /api/live)
    get "/live", ApiController, :live

    # claim writes (OCC handled server-side)
    post "/assert", ApiController, :assert
    post "/retract", ApiController, :retract
    post "/tell", ApiController, :tell
    post "/capture", ApiController, :capture
    post "/steer", ApiController, :steer
  end

  # wake frontend feed: flat /presence snapshot + /live WebSocket (raw, no
  # pipeline — /live is a WS upgrade, /presence answers any Accept).
  scope "/", TernWeb do
    get "/", ApiController, :app_view
    get "/presence", ApiController, :wake_presence
    get "/live", ApiController, :live
    get "/wake", ApiController, :wake_shell
    get "/wb", ApiController, :wake_board
    get "/list", ApiController, :list_view
    get "/board", ApiController, :board_view
    get "/agents", ApiController, :agents_view
    get "/app", ApiController, :app_view
  end
end
