defmodule LodestarWeb.Router do
  use LodestarWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {LodestarWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", LodestarWeb do
    pipe_through :api

    get "/dag", ApiController, :dag
    get "/list", ApiController, :list
    get "/presence", ApiController, :presence
    get "/entities", ApiController, :entities
    # wake derives the feed's WS as a sibling of the feed URL (/api/entities → /api/live)
    get "/live", ApiController, :live

    # claim writes (OCC handled server-side)
    post "/assert", ApiController, :assert
    post "/retract", ApiController, :retract
    post "/tell", ApiController, :tell
  end

  # wake frontend feed: flat /presence snapshot + /live WebSocket (raw, no
  # pipeline — /live is a WS upgrade, /presence answers any Accept).
  scope "/", LodestarWeb do
    get "/presence", ApiController, :wake_presence
    get "/live", ApiController, :live
    get "/wake", ApiController, :wake_shell
    get "/wb", ApiController, :wake_board
    get "/list", ApiController, :list_view
  end
end
