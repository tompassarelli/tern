(ns tern.clockify
  (:require [clojure.string :as str]
            [fram.rt :as rt]
            [fram.json :as json]))

(defn- ^String clockify-key []
  (let [env-key (fram.rt/getenv "CLOCKIFY_API_KEY")
   secret-file (fram.rt/getenv "CLOCKIFY_SECRET_FILE")]
  (cond
  (some? env-key) env-key
  (and (some? secret-file) (fram.rt/file-exists secret-file)) (str/trim (slurp secret-file))
  :else (fram.rt/error-exit "no clockify key — set CLOCKIFY_API_KEY, or CLOCKIFY_SECRET_FILE to a key file"))))

(defn- clockify-get [^String path]
  (let [body (fram.rt/http-get (str "https://api.clockify.me/api/v1" path) (clockify-key))]
  (if (= body "") (fram.json/empty) (fram.json/parse body))))

(defn- clockify-post [^String path body-data]
  (let [body (fram.rt/http-post (str "https://api.clockify.me/api/v1" path) (clockify-key) (fram.json/to-string body-data))]
  (if (= body "") (fram.json/empty) (fram.json/parse body))))

(defn ^String default-workspace []
  (let [env-ws (fram.rt/getenv "CLOCKIFY_WORKSPACE_ID")]
  (if (some? env-ws) env-ws (let [user (clockify-get "/user")
   ws (fram.json/get user "defaultWorkspace")]
  (if (nil? ws) (fram.rt/error-exit "no defaultWorkspace in /user response") ws)))))

(defn- ^String projects-path [^String dir]
  (str dir "/projects.json"))

(defn- load-projects [^String dir]
  (let [p (projects-path dir)]
  (if (fram.rt/file-exists p) (fram.json/parse (slurp p)) (fram.json/empty))))

(defn cmd-map [^String dir ^String owner ^String project-id]
  (let [mapping (load-projects dir)]
  (fram.rt/create-dirs dir)
  (spit (projects-path dir) (fram.json/to-string (fram.json/sort-keys (fram.json/put mapping owner project-id))))
  (println (str "mapped owner " owner " → clockify project " project-id))))

(defn project-for [^String dir ^String owner]
  (fram.json/get (load-projects dir) owner))

(defn cmd-workspaces []
  (doseq [w (cheshire.core/parse-string (fram.rt/http-get "https://api.clockify.me/api/v1/workspaces" (clockify-key)) false)]
  (println (str (get w "id" "") "  " (get w "name" "")))))

(defn cmd-projects []
  (let [ws (default-workspace)]
  (doseq [p (cheshire.core/parse-string (fram.rt/http-get (str "https://api.clockify.me/api/v1/workspaces/" ws "/projects?page-size=100") (clockify-key)) false)]
  (println (str (get p "id" "") "  " (get p "name" ""))))))

(defn ^String create-entry [^String ws ^String proj ^String start ^String end ^String desc]
  (let [resp (clockify-post (str "/workspaces/" ws "/time-entries") (fram.json/put (fram.json/put (fram.json/put (fram.json/put (fram.json/empty) "start" (str start "Z")) "end" (str end "Z")) "description" desc) "projectId" proj))
   cid (fram.json/get resp "id")]
  (if (nil? cid) "" cid)))
