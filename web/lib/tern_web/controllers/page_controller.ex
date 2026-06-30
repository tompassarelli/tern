defmodule TernWeb.PageController do
  use TernWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
