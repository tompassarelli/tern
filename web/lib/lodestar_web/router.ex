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
    get "/presence", ApiController, :presence
  end

  # wake frontend feed: flat /presence snapshot + /live WebSocket (raw, no
  # pipeline — /live is a WS upgrade, /presence answers any Accept).
  scope "/", LodestarWeb do
    get "/presence", ApiController, :wake_presence
    get "/live", ApiController, :live
  end
end
