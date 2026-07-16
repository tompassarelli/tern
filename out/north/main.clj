(ns north.main
  (:gen-class)
  (:require [fram.kernel :as k]
            [fram.fold :as fold]
            [fram.import :as imp]
            [fram.export :as exp]
            [north.projections :as proj]
            [north.validate :as val]
            [north.staleness :as stale]
            [north.clock :as clk]
            [north.audit :as audit]
            [north.clockify :as cf]
            [clojure.string :as str]
            [fram.rt :as rt])
  (:import [java.util Random]
           [java.util UUID]))

^{:line 60 :file "/home/tom/code/north/src/north/main.bclj"} (defn ^String uuidv7 []
  ^{:line 61 :file "/home/tom/code/north/src/north/main.bclj"} (let [ts ^{:line 61 :file "/home/tom/code/north/src/north/main.bclj"} (System/currentTimeMillis)
   r ^{:line 62 :file "/home/tom/code/north/src/north/main.bclj"} (Random.)
   msb ^{:line 63 :file "/home/tom/code/north/src/north/main.bclj"} (bit-or ^{:line 63 :file "/home/tom/code/north/src/north/main.bclj"} (bit-shift-left ts 16) 0x7000 ^{:line 63 :file "/home/tom/code/north/src/north/main.bclj"} (bit-and ^{:line 63 :file "/home/tom/code/north/src/north/main.bclj"} (.nextInt r) 0xFFF))
   lsb ^{:line 64 :file "/home/tom/code/north/src/north/main.bclj"} (bit-or ^{:line 64 :file "/home/tom/code/north/src/north/main.bclj"} (bit-shift-left 2 62) ^{:line 64 :file "/home/tom/code/north/src/north/main.bclj"} (bit-and ^{:line 64 :file "/home/tom/code/north/src/north/main.bclj"} (.nextLong r) 0x3FFFFFFFFFFFFFFF))]
  ^{:line 65 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 65 :file "/home/tom/code/north/src/north/main.bclj"} (UUID. msb lsb))))

^{:line 69 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String title-of [idx ^String te]
  ^{:line 70 :file "/home/tom/code/north/src/north/main.bclj"} (let [t ^{:line 70 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "title")]
  ^{:line 70 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 70 :file "/home/tom/code/north/src/north/main.bclj"} (some? t) t "")))

^{:line 72 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String short-id [^String te]
  ^{:line 73 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 73 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? te "@") ^{:line 73 :file "/home/tom/code/north/src/north/main.bclj"} (subs te 1) te))

^{:line 81 :file "/home/tom/code/north/src/north/main.bclj"} (defn ^String resolve-ref [idx ^String ref]
  ^{:line 82 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 82 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 82 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx ref "title")) ref ^{:line 84 :file "/home/tom/code/north/src/north/main.bclj"} (let [bare ^{:line 84 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ref)
   matches ^{:line 85 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 85 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 86 :file "/home/tom/code/north/src/north/main.bclj"} (let [h ^{:line 86 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "handle")]
  ^{:line 87 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 87 :file "/home/tom/code/north/src/north/main.bclj"} (some? h) ^{:line 87 :file "/home/tom/code/north/src/north/main.bclj"} (= h bare)))) ^{:line 88 :file "/home/tom/code/north/src/north/main.bclj"} (k/thread-ids-i idx))]
  ^{:line 89 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 89 :file "/home/tom/code/north/src/north/main.bclj"} (empty? matches) ^{:line 94 :file "/home/tom/code/north/src/north/main.bclj"} (let [pms ^{:line 94 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 94 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? bare) ^{:line 95 :file "/home/tom/code/north/src/north/main.bclj"} [] ^{:line 96 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 96 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 97 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? ^{:line 97 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) bare)) ^{:line 98 :file "/home/tom/code/north/src/north/main.bclj"} (k/thread-ids-i idx)))]
  ^{:line 99 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 99 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 99 :file "/home/tom/code/north/src/north/main.bclj"} (count pms) 1) ^{:line 99 :file "/home/tom/code/north/src/north/main.bclj"} (first pms) ref)) ^{:line 100 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 100 :file "/home/tom/code/north/src/north/main.bclj"} (fn [best te] ^{:line 101 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 101 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? best) te ^{:line 103 :file "/home/tom/code/north/src/north/main.bclj"} (let [bc ^{:line 103 :file "/home/tom/code/north/src/north/main.bclj"} (let [c ^{:line 103 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx best "created_at")]
  ^{:line 103 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 103 :file "/home/tom/code/north/src/north/main.bclj"} (some? c) c ""))
   tc ^{:line 104 :file "/home/tom/code/north/src/north/main.bclj"} (let [c ^{:line 104 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "created_at")]
  ^{:line 104 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 104 :file "/home/tom/code/north/src/north/main.bclj"} (some? c) c ""))]
  ^{:line 105 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 105 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/str-lt? bc tc) te best)))) "" matches)))))

^{:line 108 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String trunc [^String s n]
  ^{:line 109 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 109 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 109 :file "/home/tom/code/north/src/north/main.bclj"} (count s) n) ^{:line 109 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 109 :file "/home/tom/code/north/src/north/main.bclj"} (subs s 0 ^{:line 109 :file "/home/tom/code/north/src/north/main.bclj"} (- n 1)) "…") s))

^{:line 118 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String kind-bucket [^String ek]
  ^{:line 121 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 122 :file "/home/tom/code/north/src/north/main.bclj"} (= ek "concern") "concern"
  ^{:line 123 :file "/home/tom/code/north/src/north/main.bclj"} (= ek "thread") "thread"
  ^{:line 124 :file "/home/tom/code/north/src/north/main.bclj"} (= ek "mine") "mine"
  ^{:line 125 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 125 :file "/home/tom/code/north/src/north/main.bclj"} (= ek "run") ^{:line 125 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 125 :file "/home/tom/code/north/src/north/main.bclj"} (= ek "session") ^{:line 125 :file "/home/tom/code/north/src/north/main.bclj"} (= ek "lane"))) "session-telemetry"
  :else ek))

^{:line 132 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String namespace-kind [^String bare]
  ^{:line 133 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 134 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "concern-") "concern"
  ^{:line 135 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "agent:") "agent"
  ^{:line 136 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "msg:") "msg"
  ^{:line 137 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "topic-") "topic"
  ^{:line 138 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "mine:") "mine"
  ^{:line 139 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 139 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "session:") ^{:line 140 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 140 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "sess-") ^{:line 141 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 141 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "run-") ^{:line 142 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 142 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "snapshot:") ^{:line 143 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 143 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "arena-") ^{:line 144 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 144 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "cc-") ^{:line 145 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? bare "cmd:"))))))) "session-telemetry"
  :else ""))

^{:line 149 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String kind-of [idx ^String te]
  ^{:line 150 :file "/home/tom/code/north/src/north/main.bclj"} (let [ek ^{:line 150 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "kind")]
  ^{:line 151 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 151 :file "/home/tom/code/north/src/north/main.bclj"} (some? ek) ^{:line 152 :file "/home/tom/code/north/src/north/main.bclj"} (kind-bucket ek) ^{:line 153 :file "/home/tom/code/north/src/north/main.bclj"} (let [np ^{:line 153 :file "/home/tom/code/north/src/north/main.bclj"} (namespace-kind ^{:line 153 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te))]
  ^{:line 154 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 154 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 154 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? np)) np ^{:line 156 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 156 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 156 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "title")) "thread" ^{:line 159 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 159 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 159 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 159 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "cardinality")) ^{:line 160 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 160 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 160 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "value_kind")) ^{:line 161 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 161 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "acyclic")))) "predicate" "other")))))))

^{:line 167 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String driver-label [idx ^String te]
  ^{:line 168 :file "/home/tom/code/north/src/north/main.bclj"} (let [d ^{:line 168 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "driver")]
  ^{:line 169 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 169 :file "/home/tom/code/north/src/north/main.bclj"} (nil? d) "" ^{:line 171 :file "/home/tom/code/north/src/north/main.bclj"} (let [dn ^{:line 171 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx d "display_name")]
  ^{:line 172 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 172 :file "/home/tom/code/north/src/north/main.bclj"} (some? dn) dn ^{:line 172 :file "/home/tom/code/north/src/north/main.bclj"} (short-id d))))))

^{:line 174 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord LevItem [te score])

(defn levitem-te [r] (:te r))

(defn levitem-score [r] (:score r))

^{:line 175 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord NextItem [te score])

(defn nextitem-te [r] (:te r))

(defn nextitem-score [r] (:score r))

^{:line 176 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord AgendaItem [te do_on])

(defn agendaitem-te [r] (:te r))

(defn agendaitem-do_on [r] (:do_on r))

^{:line 179 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String fact-sig [c]
  ^{:line 179 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 179 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) "|" ^{:line 179 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) "|" ^{:line 179 :file "/home/tom/code/north/src/north/main.bclj"} (:r c)))

^{:line 180 :file "/home/tom/code/north/src/north/main.bclj"} (defn- sig-member-map [facts]
  ^{:line 181 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 181 :file "/home/tom/code/north/src/north/main.bclj"} (fn [m c] ^{:line 182 :file "/home/tom/code/north/src/north/main.bclj"} (assoc m ^{:line 182 :file "/home/tom/code/north/src/north/main.bclj"} (fact-sig c) true)) ^{:line 183 :file "/home/tom/code/north/src/north/main.bclj"} {} facts))

^{:line 208 :file "/home/tom/code/north/src/north/main.bclj"} (defn- read-logs-merged [^String log]
  ^{:line 209 :file "/home/tom/code/north/src/north/main.bclj"} (let [tlog ^{:line 209 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/getenv-or "FRAM_TELEMETRY_LOG" "")]
  ^{:line 210 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 210 :file "/home/tom/code/north/src/north/main.bclj"} (= tlog "") ^{:line 211 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/read-log log) ^{:line 212 :file "/home/tom/code/north/src/north/main.bclj"} (into ^{:line 212 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/read-log log) ^{:line 212 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/read-log tlog)))))

^{:line 222 :file "/home/tom/code/north/src/north/main.bclj"} (defn- retracted-sigs [ops]
  ^{:line 223 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 223 :file "/home/tom/code/north/src/north/main.bclj"} (fn [m a] ^{:line 224 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 224 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 224 :file "/home/tom/code/north/src/north/main.bclj"} (:op a) "retract") ^{:line 225 :file "/home/tom/code/north/src/north/main.bclj"} (assoc m ^{:line 225 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 225 :file "/home/tom/code/north/src/north/main.bclj"} (:l a) "|" ^{:line 225 :file "/home/tom/code/north/src/north/main.bclj"} (:p a) "|" ^{:line 225 :file "/home/tom/code/north/src/north/main.bclj"} (:r a)) true) m)) ^{:line 227 :file "/home/tom/code/north/src/north/main.bclj"} {} ops))

^{:line 229 :file "/home/tom/code/north/src/north/main.bclj"} (defn- live-facts [^String log]
  ^{:line 230 :file "/home/tom/code/north/src/north/main.bclj"} (let [warm ^{:line 230 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-live-facts ^{:line 230 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-port) log)]
  ^{:line 231 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 231 :file "/home/tom/code/north/src/north/main.bclj"} (empty? warm) ^{:line 232 :file "/home/tom/code/north/src/north/main.bclj"} (:facts ^{:line 232 :file "/home/tom/code/north/src/north/main.bclj"} (fold/fold ^{:line 232 :file "/home/tom/code/north/src/north/main.bclj"} (read-logs-merged log))) warm)))

^{:line 235 :file "/home/tom/code/north/src/north/main.bclj"} (defn- live-idx [^String log]
  ^{:line 236 :file "/home/tom/code/north/src/north/main.bclj"} (k/build-index ^{:line 236 :file "/home/tom/code/north/src/north/main.bclj"} (live-facts log)))

^{:line 239 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String tell-once [port ^String op ^String te ^String pred ^String rv]
  ^{:line 240 :file "/home/tom/code/north/src/north/main.bclj"} (let [v ^{:line 240 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-version port)]
  ^{:line 241 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 241 :file "/home/tom/code/north/src/north/main.bclj"} (< v 0) "nodaemon" ^{:line 243 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 243 :file "/home/tom/code/north/src/north/main.bclj"} (= op "assert") ^{:line 244 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-assert port te pred rv v) ^{:line 245 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-retract port te pred rv v)))))

^{:line 247 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String tell-retry [port ^String op ^String te ^String pred ^String rv tries]
  ^{:line 248 :file "/home/tom/code/north/src/north/main.bclj"} (let [resp ^{:line 248 :file "/home/tom/code/north/src/north/main.bclj"} (tell-once port op te pred rv)]
  ^{:line 249 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 249 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 249 :file "/home/tom/code/north/src/north/main.bclj"} (= resp "conflict") ^{:line 249 :file "/home/tom/code/north/src/north/main.bclj"} (> tries 0)) ^{:line 250 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port op te pred rv ^{:line 250 :file "/home/tom/code/north/src/north/main.bclj"} (- tries 1)) resp)))

^{:line 254 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^Boolean ctrl? [^String s]
  ^{:line 255 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 255 :file "/home/tom/code/north/src/north/main.bclj"} (str/includes? s "\n") ^{:line 255 :file "/home/tom/code/north/src/north/main.bclj"} (str/includes? s "\r")))

^{:line 257 :file "/home/tom/code/north/src/north/main.bclj"} (defn- add-fact [acc ^String te ^String p ^String v]
  ^{:line 258 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 258 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? v) acc ^{:line 258 :file "/home/tom/code/north/src/north/main.bclj"} (conj acc ^{:line 258 :file "/home/tom/code/north/src/north/main.bclj"} (k/->Fact te p v))))

^{:line 260 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String ref-or-blank [^String v]
  ^{:line 261 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 261 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? v) "" ^{:line 261 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" v)))

^{:line 263 :file "/home/tom/code/north/src/north/main.bclj"} (defn- capture-facts [^String te ^String title ^String owner ^String source ^String author ^String lead ^String proposed ^String created-at ^String today]
  ^{:line 269 :file "/home/tom/code/north/src/north/main.bclj"} (let [c ^{:line 269 :file "/home/tom/code/north/src/north/main.bclj"} (add-fact ^{:line 269 :file "/home/tom/code/north/src/north/main.bclj"} [] te "title" title)
   c ^{:line 275 :file "/home/tom/code/north/src/north/main.bclj"} (add-fact c te "kind" "thread")
   c ^{:line 278 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 278 :file "/home/tom/code/north/src/north/main.bclj"} (= owner "personal") c ^{:line 278 :file "/home/tom/code/north/src/north/main.bclj"} (add-fact c te "owner" owner))
   c ^{:line 279 :file "/home/tom/code/north/src/north/main.bclj"} (add-fact c te "source" source)
   c ^{:line 280 :file "/home/tom/code/north/src/north/main.bclj"} (add-fact c te "created_by" ^{:line 280 :file "/home/tom/code/north/src/north/main.bclj"} (ref-or-blank author))
   c ^{:line 281 :file "/home/tom/code/north/src/north/main.bclj"} (add-fact c te "lead" ^{:line 281 :file "/home/tom/code/north/src/north/main.bclj"} (ref-or-blank lead))
   c ^{:line 282 :file "/home/tom/code/north/src/north/main.bclj"} (add-fact c te "proposed_by" ^{:line 282 :file "/home/tom/code/north/src/north/main.bclj"} (ref-or-blank proposed))
   c ^{:line 285 :file "/home/tom/code/north/src/north/main.bclj"} (add-fact c te "created_at" created-at)
   c ^{:line 286 :file "/home/tom/code/north/src/north/main.bclj"} (add-fact c te "updated_at" today)
   c ^{:line 287 :file "/home/tom/code/north/src/north/main.bclj"} (add-fact c te "committed" today)]
  c))

^{:line 290 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-capture [^String threads-dir ^String log ^String title ^String owner]
  ^{:line 291 :file "/home/tom/code/north/src/north/main.bclj"} (let [source ^{:line 291 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/getenv-or "NORTH_SOURCE" "self")
   author ^{:line 292 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/getenv-or "NORTH_AUTHOR" "you")
   lead ^{:line 293 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/getenv-or "NORTH_LEAD" "")
   proposed ^{:line 294 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/getenv-or "NORTH_PROPOSED_BY" "")]
  ^{:line 295 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 296 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 296 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? title) ^{:line 296 :file "/home/tom/code/north/src/north/main.bclj"} (ctrl? title)) ^{:line 297 :file "/home/tom/code/north/src/north/main.bclj"} (println "usage: capture <title> [owner]   (title must be a non-empty single line)")
  ^{:line 298 :file "/home/tom/code/north/src/north/main.bclj"} (ctrl? owner) ^{:line 299 :file "/home/tom/code/north/src/north/main.bclj"} (println "capture: owner must be a single line")
  ^{:line 300 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 300 :file "/home/tom/code/north/src/north/main.bclj"} (ctrl? source) ^{:line 300 :file "/home/tom/code/north/src/north/main.bclj"} (ctrl? author) ^{:line 300 :file "/home/tom/code/north/src/north/main.bclj"} (ctrl? lead) ^{:line 300 :file "/home/tom/code/north/src/north/main.bclj"} (ctrl? proposed)) ^{:line 301 :file "/home/tom/code/north/src/north/main.bclj"} (println "capture: NORTH_SOURCE/AUTHOR/LEAD/PROPOSED_BY must each be a single line")
  :else ^{:line 303 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 304 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/ensure-dir threads-dir)
  ^{:line 305 :file "/home/tom/code/north/src/north/main.bclj"} (let [id ^{:line 305 :file "/home/tom/code/north/src/north/main.bclj"} (uuidv7)
   slug ^{:line 306 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/slugify title)
   today ^{:line 307 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/today-iso)
   created-at ^{:line 308 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/now-iso)
   te ^{:line 309 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" id)
   path ^{:line 310 :file "/home/tom/code/north/src/north/main.bclj"} (str threads-dir "/" id "-" slug ".md")
   port ^{:line 311 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-port)]
  ^{:line 320 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 320 :file "/home/tom/code/north/src/north/main.bclj"} (< ^{:line 320 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-version port) 0) ^{:line 321 :file "/home/tom/code/north/src/north/main.bclj"} (println "no coordinator on 127.0.0.1:7977 — writes won't serialize. Run `north up`.") ^{:line 322 :file "/home/tom/code/north/src/north/main.bclj"} (let [facts ^{:line 322 :file "/home/tom/code/north/src/north/main.bclj"} (capture-facts te title owner source author lead proposed created-at today)
   results ^{:line 323 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 323 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 324 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port "assert" ^{:line 324 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) ^{:line 324 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) ^{:line 324 :file "/home/tom/code/north/src/north/main.bclj"} (:r c) 5)) facts)
   oks ^{:line 326 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 326 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 326 :file "/home/tom/code/north/src/north/main.bclj"} (fn [r] ^{:line 326 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? r "ok:")) results))]
  ^{:line 327 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 327 :file "/home/tom/code/north/src/north/main.bclj"} (= oks ^{:line 327 :file "/home/tom/code/north/src/north/main.bclj"} (count facts)) ^{:line 328 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 329 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/spit-file path ^{:line 329 :file "/home/tom/code/north/src/north/main.bclj"} (exp/thread-md ^{:line 329 :file "/home/tom/code/north/src/north/main.bclj"} (:facts ^{:line 329 :file "/home/tom/code/north/src/north/main.bclj"} (fold/fold ^{:line 329 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/read-log log))) te))
  ^{:line 330 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 330 :file "/home/tom/code/north/src/north/main.bclj"} (str "captured -> " te "  " title "  [owner: " owner "]\n" "  file:      " path "\n" "  committed: " oks " facts via coordinator. Next: north tell " id " <pred> <value>"))) ^{:line 333 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 333 :file "/home/tom/code/north/src/north/main.bclj"} (str "capture PARTIAL: only " oks "/" ^{:line 333 :file "/home/tom/code/north/src/north/main.bclj"} (count facts) " fact(s) committed (write conflict / no daemon?). Re-run — nothing is stranded in files."))))))))))

^{:line 344 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^Boolean id-like? [^String bare]
  ^{:line 348 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 348 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 348 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? bare)) ^{:line 349 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? ^{:line 349 :file "/home/tom/code/north/src/north/main.bclj"} (str/replace bare #"[0-9a-f-]" "")) ^{:line 350 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 350 :file "/home/tom/code/north/src/north/main.bclj"} (str/includes? bare "-") ^{:line 350 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 350 :file "/home/tom/code/north/src/north/main.bclj"} (count bare) 8))))

^{:line 352 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-resolve [^String log ^String ref]
  ^{:line 353 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 353 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   r ^{:line 354 :file "/home/tom/code/north/src/north/main.bclj"} (resolve-ref idx ref)]
  ^{:line 355 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 355 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 355 :file "/home/tom/code/north/src/north/main.bclj"} (= r ref) ^{:line 356 :file "/home/tom/code/north/src/north/main.bclj"} (id-like? ^{:line 356 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ref)) ^{:line 357 :file "/home/tom/code/north/src/north/main.bclj"} (nil? ^{:line 357 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx ^{:line 357 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" ^{:line 357 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ref)) "title"))) ^{:line 358 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 358 :file "/home/tom/code/north/src/north/main.bclj"} (str "ERROR unresolved id-like ref " ref " — not a thread id, unique prefix, or handle" " (ambiguous/truncated? `north show " ^{:line 360 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ref) "` lists candidates)")) ^{:line 361 :file "/home/tom/code/north/src/north/main.bclj"} (println r))))

^{:line 369 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-done-bars [^String log ^String ref]
  ^{:line 370 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 370 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   te ^{:line 371 :file "/home/tom/code/north/src/north/main.bclj"} (resolve-ref idx ^{:line 371 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 371 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? ref "@") ref ^{:line 371 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" ref)))
   bars ^{:line 372 :file "/home/tom/code/north/src/north/main.bclj"} (k/many-i idx te "done_when")
   evs ^{:line 373 :file "/home/tom/code/north/src/north/main.bclj"} (k/many-i idx te "bar_evidence")]
  ^{:line 374 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 374 :file "/home/tom/code/north/src/north/main.bclj"} (empty? bars) nil ^{:line 376 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 377 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 377 :file "/home/tom/code/north/src/north/main.bclj"} (str "DONE BARS on " te " — this outcome claims they are met; cite probe + observed result:"))
  ^{:line 378 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [b bars]
  ^{:line 378 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 378 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 378 :file "/home/tom/code/north/src/north/main.bclj"} (stale/bar-mark evs b) " " b)))
  ^{:line 379 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 379 :file "/home/tom/code/north/src/north/main.bclj"} (str "  evidence: north tell " ^{:line 379 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) " bar_evidence \"<bar> → <observed result>\""))))))

^{:line 382 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-audit [^String log]
  ^{:line 383 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 383 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   rd ^{:line 384 :file "/home/tom/code/north/src/north/main.bclj"} (audit/repo-drift idx)]
  ^{:line 385 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 385 :file "/home/tom/code/north/src/north/main.bclj"} (str "REPO DRIFT — " ^{:line 385 :file "/home/tom/code/north/src/north/main.bclj"} (count rd) " group(s):"))
  ^{:line 386 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [g rd]
  ^{:line 387 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 387 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 387 :file "/home/tom/code/north/src/north/main.bclj"} (:norm g) ": " ^{:line 387 :file "/home/tom/code/north/src/north/main.bclj"} (str/join ", " ^{:line 387 :file "/home/tom/code/north/src/north/main.bclj"} (:forms g)))))))

^{:line 393 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-validate [^String log]
  ^{:line 394 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 394 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   problems ^{:line 395 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 396 :file "/home/tom/code/north/src/north/main.bclj"} (fn [acc te] ^{:line 397 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 397 :file "/home/tom/code/north/src/north/main.bclj"} (fn [a v] ^{:line 398 :file "/home/tom/code/north/src/north/main.bclj"} (conj a ^{:line 398 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 398 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) ": " v))) acc ^{:line 399 :file "/home/tom/code/north/src/north/main.bclj"} (val/violations-i idx te))) ^{:line 400 :file "/home/tom/code/north/src/north/main.bclj"} [] ^{:line 401 :file "/home/tom/code/north/src/north/main.bclj"} (k/thread-ids-i idx))]
  ^{:line 402 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 402 :file "/home/tom/code/north/src/north/main.bclj"} (empty? problems) ^{:line 403 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 403 :file "/home/tom/code/north/src/north/main.bclj"} (str "OK — " ^{:line 403 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 403 :file "/home/tom/code/north/src/north/main.bclj"} (k/thread-ids-i idx)) " threads, no violations.")) ^{:line 404 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 404 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [p problems]
  ^{:line 404 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 404 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " p)))
  ^{:line 405 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 405 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 405 :file "/home/tom/code/north/src/north/main.bclj"} (count problems) " violation(s)."))))))

^{:line 407 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-ready [^String log ^Boolean all]
  ^{:line 408 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 408 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   today ^{:line 409 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/today-iso)
   raw ^{:line 410 :file "/home/tom/code/north/src/north/main.bclj"} (proj/ready idx today fram.rt/str-lt?)
   rs ^{:line 414 :file "/home/tom/code/north/src/north/main.bclj"} (if all raw ^{:line 415 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 415 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 415 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 415 :file "/home/tom/code/north/src/north/main.bclj"} (kind-of idx te) "thread")) raw))
   ranked ^{:line 418 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 418 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 418 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 418 :file "/home/tom/code/north/src/north/main.bclj"} (- 0 ^{:line 418 :file "/home/tom/code/north/src/north/main.bclj"} (proj/leverage-score idx te))) rs))
   shown ^{:line 419 :file "/home/tom/code/north/src/north/main.bclj"} (if all ranked ^{:line 419 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 419 :file "/home/tom/code/north/src/north/main.bclj"} (take 15 ranked)))]
  ^{:line 420 :file "/home/tom/code/north/src/north/main.bclj"} (if all ^{:line 421 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 421 :file "/home/tom/code/north/src/north/main.bclj"} (str "READY NOW — " ^{:line 421 :file "/home/tom/code/north/src/north/main.bclj"} (count rs))) ^{:line 422 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 422 :file "/home/tom/code/north/src/north/main.bclj"} (str "READY NOW — top " ^{:line 422 :file "/home/tom/code/north/src/north/main.bclj"} (count shown) " of " ^{:line 422 :file "/home/tom/code/north/src/north/main.bclj"} (count rs) " by leverage")))
  ^{:line 423 :file "/home/tom/code/north/src/north/main.bclj"} (println "  ready = committed + unblocked, start anytime (vs open = merely not-done, may still be blocked)")
  ^{:line 424 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [te shown]
  ^{:line 425 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 425 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 425 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) "  " ^{:line 425 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 425 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx te) 56))))
  ^{:line 426 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 426 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 426 :file "/home/tom/code/north/src/north/main.bclj"} (not all) ^{:line 426 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 426 :file "/home/tom/code/north/src/north/main.bclj"} (count rs) ^{:line 426 :file "/home/tom/code/north/src/north/main.bclj"} (count shown))) ^{:line 426 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 427 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 427 :file "/home/tom/code/north/src/north/main.bclj"} (str "  … +" ^{:line 427 :file "/home/tom/code/north/src/north/main.bclj"} (- ^{:line 427 :file "/home/tom/code/north/src/north/main.bclj"} (count rs) ^{:line 427 :file "/home/tom/code/north/src/north/main.bclj"} (count shown)) " more · north ready --all"))))))

^{:line 429 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-blocked [^String log]
  ^{:line 430 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 430 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   today ^{:line 431 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/today-iso)
   before? fram.rt/str-lt?
   bs ^{:line 433 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 433 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 433 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 433 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-i idx te today before?) "blocked")) ^{:line 434 :file "/home/tom/code/north/src/north/main.bclj"} (proj/work-thread-ids-i idx))]
  ^{:line 435 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 435 :file "/home/tom/code/north/src/north/main.bclj"} (str "BLOCKED — " ^{:line 435 :file "/home/tom/code/north/src/north/main.bclj"} (count bs)))
  ^{:line 436 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [te bs]
  ^{:line 437 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 437 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 437 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) "  " ^{:line 437 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 437 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx te) 48) "  (waiting on " ^{:line 438 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 438 :file "/home/tom/code/north/src/north/main.bclj"} (proj/incomplete-deps idx te)) ")")))))

^{:line 440 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-leverage [^String log]
  ^{:line 441 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 441 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   cands ^{:line 442 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 442 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 442 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 442 :file "/home/tom/code/north/src/north/main.bclj"} (proj/terminal-i? idx te))) ^{:line 443 :file "/home/tom/code/north/src/north/main.bclj"} (proj/work-thread-ids-i idx))
   items ^{:line 444 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 444 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 444 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 444 :file "/home/tom/code/north/src/north/main.bclj"} (:score it) 0)) ^{:line 445 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 445 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 446 :file "/home/tom/code/north/src/north/main.bclj"} (->LevItem te ^{:line 446 :file "/home/tom/code/north/src/north/main.bclj"} (proj/leverage-score idx te))) cands))
   ranked ^{:line 448 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 448 :file "/home/tom/code/north/src/north/main.bclj"} (take 15 ^{:line 448 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 448 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 448 :file "/home/tom/code/north/src/north/main.bclj"} (- 0 ^{:line 448 :file "/home/tom/code/north/src/north/main.bclj"} (:score it))) items)))]
  ^{:line 449 :file "/home/tom/code/north/src/north/main.bclj"} (println "TOP UNBLOCKERS — finishing this transitively frees the most stuck threads")
  ^{:line 450 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [it ranked]
  ^{:line 451 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 451 :file "/home/tom/code/north/src/north/main.bclj"} (str "  unblocks " ^{:line 451 :file "/home/tom/code/north/src/north/main.bclj"} (:score it) "  " ^{:line 451 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 451 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) "  " ^{:line 452 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 452 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 452 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) 46))))))

^{:line 454 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-next [^String log]
  ^{:line 455 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 455 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   today ^{:line 456 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/today-iso)
   items ^{:line 457 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 458 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 459 :file "/home/tom/code/north/src/north/main.bclj"} (let [lev ^{:line 459 :file "/home/tom/code/north/src/north/main.bclj"} (proj/leverage-score idx te)
   doo ^{:line 460 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "do_on")
   urg ^{:line 461 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 461 :file "/home/tom/code/north/src/north/main.bclj"} (some? doo) ^{:line 462 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 463 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/str-lt? doo today) 5
  ^{:line 464 :file "/home/tom/code/north/src/north/main.bclj"} (= doo today) 3
  :else 0) 0)
   mom ^{:line 467 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 467 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 467 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "driver")) 2 0)]
  ^{:line 468 :file "/home/tom/code/north/src/north/main.bclj"} (->NextItem te ^{:line 468 :file "/home/tom/code/north/src/north/main.bclj"} (+ ^{:line 468 :file "/home/tom/code/north/src/north/main.bclj"} (* 3 lev) ^{:line 468 :file "/home/tom/code/north/src/north/main.bclj"} (+ urg mom))))) ^{:line 469 :file "/home/tom/code/north/src/north/main.bclj"} (proj/ready idx today fram.rt/str-lt?))
   ranked ^{:line 470 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 470 :file "/home/tom/code/north/src/north/main.bclj"} (take 12 ^{:line 470 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 470 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 470 :file "/home/tom/code/north/src/north/main.bclj"} (- 0 ^{:line 470 :file "/home/tom/code/north/src/north/main.bclj"} (:score it))) items)))]
  ^{:line 471 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 471 :file "/home/tom/code/north/src/north/main.bclj"} (str "WHAT TO WORK ON — top picks (" today ")"))
  ^{:line 472 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [it ranked]
  ^{:line 473 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 473 :file "/home/tom/code/north/src/north/main.bclj"} (str "  [" ^{:line 473 :file "/home/tom/code/north/src/north/main.bclj"} (:score it) "] " ^{:line 473 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 473 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) "  " ^{:line 474 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 474 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 474 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) 50))))))

^{:line 476 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-agenda [^String log]
  ^{:line 477 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 477 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   today ^{:line 478 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/today-iso)
   cands ^{:line 479 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 479 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 480 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 480 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 480 :file "/home/tom/code/north/src/north/main.bclj"} (proj/terminal-i? idx te)) ^{:line 480 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 480 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "do_on")))) ^{:line 481 :file "/home/tom/code/north/src/north/main.bclj"} (proj/work-thread-ids-i idx))
   items ^{:line 482 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 482 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 483 :file "/home/tom/code/north/src/north/main.bclj"} (->AgendaItem te ^{:line 483 :file "/home/tom/code/north/src/north/main.bclj"} (let [d ^{:line 483 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "do_on")]
  ^{:line 483 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 483 :file "/home/tom/code/north/src/north/main.bclj"} (some? d) d "")))) cands)
   overdue ^{:line 485 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 485 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 485 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 485 :file "/home/tom/code/north/src/north/main.bclj"} (:do_on it)) ^{:line 486 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 486 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 486 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/str-lt? ^{:line 486 :file "/home/tom/code/north/src/north/main.bclj"} (:do_on it) today)) items)))
   todayb ^{:line 487 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 487 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 487 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 487 :file "/home/tom/code/north/src/north/main.bclj"} (:do_on it) today)) items)
   upcoming ^{:line 488 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 488 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 488 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 488 :file "/home/tom/code/north/src/north/main.bclj"} (:do_on it)) ^{:line 489 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 489 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 489 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/str-lt? today ^{:line 489 :file "/home/tom/code/north/src/north/main.bclj"} (:do_on it))) items)))]
  ^{:line 490 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 490 :file "/home/tom/code/north/src/north/main.bclj"} (str "AGENDA — " today))
  ^{:line 491 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 491 :file "/home/tom/code/north/src/north/main.bclj"} (str "OVERDUE (" ^{:line 491 :file "/home/tom/code/north/src/north/main.bclj"} (count overdue) ")"))
  ^{:line 492 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [it overdue]
  ^{:line 492 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 492 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 492 :file "/home/tom/code/north/src/north/main.bclj"} (:do_on it) "  " ^{:line 492 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 492 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) "  " ^{:line 492 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 492 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 492 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) 44))))
  ^{:line 493 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 493 :file "/home/tom/code/north/src/north/main.bclj"} (str "TODAY (" ^{:line 493 :file "/home/tom/code/north/src/north/main.bclj"} (count todayb) ")"))
  ^{:line 494 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [it todayb]
  ^{:line 494 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 494 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 494 :file "/home/tom/code/north/src/north/main.bclj"} (:do_on it) "  " ^{:line 494 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 494 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) "  " ^{:line 494 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 494 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 494 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) 44))))
  ^{:line 495 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 495 :file "/home/tom/code/north/src/north/main.bclj"} (str "UPCOMING (" ^{:line 495 :file "/home/tom/code/north/src/north/main.bclj"} (count upcoming) ")"))
  ^{:line 496 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [it upcoming]
  ^{:line 496 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 496 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 496 :file "/home/tom/code/north/src/north/main.bclj"} (:do_on it) "  " ^{:line 496 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 496 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) "  " ^{:line 496 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 496 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 496 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) 44))))))

^{:line 498 :file "/home/tom/code/north/src/north/main.bclj"} (defn- board-group [idx ^String label grp]
  ^{:line 499 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 499 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 499 :file "/home/tom/code/north/src/north/main.bclj"} (empty? grp)) ^{:line 499 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 500 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 500 :file "/home/tom/code/north/src/north/main.bclj"} (str "\n" ^{:line 500 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-emoji idx label) " " label " (" ^{:line 500 :file "/home/tom/code/north/src/north/main.bclj"} (count grp) ")"))
  ^{:line 501 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [te grp]
  ^{:line 502 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 502 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 502 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) "  " ^{:line 502 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 502 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx te) 52)))))))

^{:line 504 :file "/home/tom/code/north/src/north/main.bclj"} (defn- in-condition [idx nonterm ^String today before? ^String c]
  ^{:line 505 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 505 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 505 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 505 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-i idx te today before?) c)) nonterm))

^{:line 530 :file "/home/tom/code/north/src/north/main.bclj"} (defn- lease-exp-secs [idx ^String driverref]
  ^{:line 535 :file "/home/tom/code/north/src/north/main.bclj"} (let [handle ^{:line 535 :file "/home/tom/code/north/src/north/main.bclj"} (short-id driverref)
   v ^{:line 536 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx ^{:line 536 :file "/home/tom/code/north/src/north/main.bclj"} (str "@lease:session:" handle) "lease")]
  ^{:line 537 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 537 :file "/home/tom/code/north/src/north/main.bclj"} (nil? v) -1 ^{:line 539 :file "/home/tom/code/north/src/north/main.bclj"} (let [parts ^{:line 539 :file "/home/tom/code/north/src/north/main.bclj"} (str/split v #"\|")]
  ^{:line 540 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 540 :file "/home/tom/code/north/src/north/main.bclj"} (< ^{:line 540 :file "/home/tom/code/north/src/north/main.bclj"} (count parts) 2) -1 ^{:line 542 :file "/home/tom/code/north/src/north/main.bclj"} (let [expms ^{:line 542 :file "/home/tom/code/north/src/north/main.bclj"} (nth parts 1)]
  ^{:line 543 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 543 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 543 :file "/home/tom/code/north/src/north/main.bclj"} (count expms) 3) ^{:line 544 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/parse-int ^{:line 544 :file "/home/tom/code/north/src/north/main.bclj"} (subs expms 0 ^{:line 544 :file "/home/tom/code/north/src/north/main.bclj"} (- ^{:line 544 :file "/home/tom/code/north/src/north/main.bclj"} (count expms) 3))) -1)))))))

^{:line 547 :file "/home/tom/code/north/src/north/main.bclj"} (defn- dt->secs [^String s]
  ^{:line 551 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 552 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/is-iso-datetime-19 s) ^{:line 552 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds s)
  ^{:line 553 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/is-iso-datetime-16 s) ^{:line 553 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds s)
  ^{:line 554 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 554 :file "/home/tom/code/north/src/north/main.bclj"} (= 10 ^{:line 554 :file "/home/tom/code/north/src/north/main.bclj"} (count s)) ^{:line 554 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/is-iso-datetime-19 ^{:line 554 :file "/home/tom/code/north/src/north/main.bclj"} (str s "T00:00:00"))) ^{:line 555 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds ^{:line 555 :file "/home/tom/code/north/src/north/main.bclj"} (str s "T00:00:00"))
  :else -1))

^{:line 558 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^Boolean driver-live? [idx ^String te now-secs window-secs]
  ^{:line 559 :file "/home/tom/code/north/src/north/main.bclj"} (let [d ^{:line 559 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "driver")]
  ^{:line 560 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 560 :file "/home/tom/code/north/src/north/main.bclj"} (nil? d) false ^{:line 562 :file "/home/tom/code/north/src/north/main.bclj"} (let [e ^{:line 562 :file "/home/tom/code/north/src/north/main.bclj"} (lease-exp-secs idx d)]
  ^{:line 563 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 563 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 563 :file "/home/tom/code/north/src/north/main.bclj"} (> e 0) ^{:line 563 :file "/home/tom/code/north/src/north/main.bclj"} (> e now-secs)) true ^{:line 565 :file "/home/tom/code/north/src/north/main.bclj"} (let [u ^{:line 565 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "updated_at")]
  ^{:line 566 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 566 :file "/home/tom/code/north/src/north/main.bclj"} (nil? u) false ^{:line 568 :file "/home/tom/code/north/src/north/main.bclj"} (let [us ^{:line 568 :file "/home/tom/code/north/src/north/main.bclj"} (dt->secs u)]
  ^{:line 569 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 569 :file "/home/tom/code/north/src/north/main.bclj"} (> us 0) ^{:line 569 :file "/home/tom/code/north/src/north/main.bclj"} (< ^{:line 569 :file "/home/tom/code/north/src/north/main.bclj"} (- now-secs us) window-secs))))))))))

^{:line 571 :file "/home/tom/code/north/src/north/main.bclj"} (defn- driver-stale-window-secs []
  ^{:line 574 :file "/home/tom/code/north/src/north/main.bclj"} (let [d ^{:line 574 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/parse-int ^{:line 574 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/getenv-or "NORTH_DRIVER_STALE_DAYS" "14"))]
  ^{:line 575 :file "/home/tom/code/north/src/north/main.bclj"} (* ^{:line 575 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 575 :file "/home/tom/code/north/src/north/main.bclj"} (> d 0) d 14) 86400)))

^{:line 581 :file "/home/tom/code/north/src/north/main.bclj"} (defn- board-full [idx ^String today before? nonterm]
  ^{:line 582 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 583 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 583 :file "/home/tom/code/north/src/north/main.bclj"} (str "THREADS — " ^{:line 583 :file "/home/tom/code/north/src/north/main.bclj"} (count nonterm) " open"))
  ^{:line 584 :file "/home/tom/code/north/src/north/main.bclj"} (board-group idx "active" ^{:line 584 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx nonterm today before? "active"))
  ^{:line 585 :file "/home/tom/code/north/src/north/main.bclj"} (board-group idx "ready" ^{:line 585 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx nonterm today before? "ready"))
  ^{:line 586 :file "/home/tom/code/north/src/north/main.bclj"} (board-group idx "blocked" ^{:line 586 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx nonterm today before? "blocked"))
  ^{:line 587 :file "/home/tom/code/north/src/north/main.bclj"} (board-group idx "dormant" ^{:line 587 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx nonterm today before? "dormant"))
  ^{:line 588 :file "/home/tom/code/north/src/north/main.bclj"} (board-group idx "draft" ^{:line 588 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx nonterm today before? "draft"))))

^{:line 590 :file "/home/tom/code/north/src/north/main.bclj"} (defn- board-curated [idx ^String today before? nonterm now-secs window-secs]
  ^{:line 596 :file "/home/tom/code/north/src/north/main.bclj"} (let [threads ^{:line 596 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 596 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 596 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 596 :file "/home/tom/code/north/src/north/main.bclj"} (kind-of idx te) "thread")) nonterm)
   active-all ^{:line 601 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx threads today before? "active")
   active ^{:line 602 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 602 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 602 :file "/home/tom/code/north/src/north/main.bclj"} (driver-live? idx te now-secs window-secs)) active-all)
   nparked ^{:line 603 :file "/home/tom/code/north/src/north/main.bclj"} (- ^{:line 603 :file "/home/tom/code/north/src/north/main.bclj"} (count active-all) ^{:line 603 :file "/home/tom/code/north/src/north/main.bclj"} (count active))
   readyl ^{:line 604 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx threads today before? "ready")
   blockedl ^{:line 605 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx threads today before? "blocked")
   nconcern ^{:line 609 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 609 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 609 :file "/home/tom/code/north/src/north/main.bclj"} (fn [s] ^{:line 609 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 609 :file "/home/tom/code/north/src/north/main.bclj"} (kind-of idx s) "concern")) ^{:line 610 :file "/home/tom/code/north/src/north/main.bclj"} (:subjects idx)))
   ashow ^{:line 611 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 611 :file "/home/tom/code/north/src/north/main.bclj"} (take 20 active))
   ritems ^{:line 612 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 612 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 612 :file "/home/tom/code/north/src/north/main.bclj"} (->LevItem te ^{:line 612 :file "/home/tom/code/north/src/north/main.bclj"} (proj/leverage-score idx te))) readyl)
   rranked ^{:line 613 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 613 :file "/home/tom/code/north/src/north/main.bclj"} (take 15 ^{:line 613 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 613 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 613 :file "/home/tom/code/north/src/north/main.bclj"} (- 0 ^{:line 613 :file "/home/tom/code/north/src/north/main.bclj"} (:score it))) ritems)))]
  ^{:line 614 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 614 :file "/home/tom/code/north/src/north/main.bclj"} (str "THREADS — " ^{:line 614 :file "/home/tom/code/north/src/north/main.bclj"} (count threads) " open threads · " ^{:line 614 :file "/home/tom/code/north/src/north/main.bclj"} (count active) " active · " ^{:line 615 :file "/home/tom/code/north/src/north/main.bclj"} (count readyl) " ready · " ^{:line 615 :file "/home/tom/code/north/src/north/main.bclj"} (count blockedl) " blocked · " nconcern " concerns   (north threads --all for the full kanban)"))
  ^{:line 619 :file "/home/tom/code/north/src/north/main.bclj"} (println "  open = not done · active = being driven now · ready = committed + unblocked, start anytime · blocked = waiting on a dependency")
  ^{:line 620 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 620 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 620 :file "/home/tom/code/north/src/north/main.bclj"} (empty? active)) ^{:line 620 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 621 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 621 :file "/home/tom/code/north/src/north/main.bclj"} (str "\n" ^{:line 621 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-emoji idx "active") " ACTIVE — who's on what (" ^{:line 621 :file "/home/tom/code/north/src/north/main.bclj"} (count active) ")"))
  ^{:line 622 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [te ashow]
  ^{:line 623 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 623 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 623 :file "/home/tom/code/north/src/north/main.bclj"} (let [dl ^{:line 623 :file "/home/tom/code/north/src/north/main.bclj"} (driver-label idx te)]
  ^{:line 623 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 623 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? dl) "?" dl)) "  " ^{:line 624 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) "  " ^{:line 624 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 624 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx te) 44))))
  ^{:line 625 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 625 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 625 :file "/home/tom/code/north/src/north/main.bclj"} (count active) ^{:line 625 :file "/home/tom/code/north/src/north/main.bclj"} (count ashow)) ^{:line 625 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 626 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 626 :file "/home/tom/code/north/src/north/main.bclj"} (str "  … +" ^{:line 626 :file "/home/tom/code/north/src/north/main.bclj"} (- ^{:line 626 :file "/home/tom/code/north/src/north/main.bclj"} (count active) ^{:line 626 :file "/home/tom/code/north/src/north/main.bclj"} (count ashow)) " more · north threads --all"))))))
  ^{:line 627 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 627 :file "/home/tom/code/north/src/north/main.bclj"} (> nparked 0) ^{:line 627 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 628 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 628 :file "/home/tom/code/north/src/north/main.bclj"} (str "\n" nparked " parked driver(s) — stale, not shown (north threads --all)"))))
  ^{:line 629 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 629 :file "/home/tom/code/north/src/north/main.bclj"} (str "\n" ^{:line 629 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-emoji idx "ready") " READY — top " ^{:line 629 :file "/home/tom/code/north/src/north/main.bclj"} (count rranked) " of " ^{:line 630 :file "/home/tom/code/north/src/north/main.bclj"} (count readyl) " by leverage"))
  ^{:line 631 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [it rranked]
  ^{:line 632 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 632 :file "/home/tom/code/north/src/north/main.bclj"} (str "  unblocks " ^{:line 632 :file "/home/tom/code/north/src/north/main.bclj"} (:score it) "  " ^{:line 632 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 632 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) "  " ^{:line 632 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 632 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 632 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) 44))))
  ^{:line 633 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 633 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 633 :file "/home/tom/code/north/src/north/main.bclj"} (count readyl) ^{:line 633 :file "/home/tom/code/north/src/north/main.bclj"} (count rranked)) ^{:line 633 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 634 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 634 :file "/home/tom/code/north/src/north/main.bclj"} (str "  … +" ^{:line 634 :file "/home/tom/code/north/src/north/main.bclj"} (- ^{:line 634 :file "/home/tom/code/north/src/north/main.bclj"} (count readyl) ^{:line 634 :file "/home/tom/code/north/src/north/main.bclj"} (count rranked)) " more · north threads --all"))))
  ^{:line 635 :file "/home/tom/code/north/src/north/main.bclj"} (println "  machinery/agents/daemons → north dashboard")))

^{:line 637 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-board [^String log ^Boolean all]
  ^{:line 638 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 638 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   today ^{:line 639 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/today-iso)
   before? fram.rt/str-lt?
   nonterm ^{:line 641 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 641 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 641 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 641 :file "/home/tom/code/north/src/north/main.bclj"} (proj/terminal-i? idx te))) ^{:line 642 :file "/home/tom/code/north/src/north/main.bclj"} (proj/work-thread-ids-i idx))]
  ^{:line 643 :file "/home/tom/code/north/src/north/main.bclj"} (if all ^{:line 644 :file "/home/tom/code/north/src/north/main.bclj"} (board-full idx today before? nonterm) ^{:line 645 :file "/home/tom/code/north/src/north/main.bclj"} (board-curated idx today before? nonterm ^{:line 646 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds ^{:line 646 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/now-iso)) ^{:line 647 :file "/home/tom/code/north/src/north/main.bclj"} (driver-stale-window-secs)))))

^{:line 650 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord JThread [id title condition emoji])

(defn jthread-id [r] (:id r))

(defn jthread-title [r] (:title r))

(defn jthread-condition [r] (:condition r))

(defn jthread-emoji [r] (:emoji r))

^{:line 651 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord JPresentation [active ready blocked draft])

(defn jpresentation-active [r] (:active r))

(defn jpresentation-ready [r] (:ready r))

(defn jpresentation-blocked [r] (:blocked r))

(defn jpresentation-draft [r] (:draft r))

^{:line 652 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord JReview [id title pred detail])

(defn jreview-id [r] (:id r))

(defn jreview-title [r] (:title r))

(defn jreview-pred [r] (:pred r))

(defn jreview-detail [r] (:detail r))

^{:line 653 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord JFact [predicate value])

(defn jfact-predicate [r] (:predicate r))

(defn jfact-value [r] (:value r))

^{:line 654 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord JClockRow [id title est_h actual_sec done])

(defn jclockrow-id [r] (:id r))

(defn jclockrow-title [r] (:title r))

(defn jclockrow-est_h [r] (:est_h r))

(defn jclockrow-actual_sec [r] (:actual_sec r))

(defn jclockrow-done [r] (:done r))

^{:line 655 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord JCalib [pct sample])

(defn jcalib-pct [r] (:pct r))

(defn jcalib-sample [r] (:sample r))

^{:line 656 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord JClockReport [rows calibration])

(defn jclockreport-rows [r] (:rows r))

(defn jclockreport-calibration [r] (:calibration r))

^{:line 658 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^JThread jthread [idx ^String te ^String today before?]
  ^{:line 659 :file "/home/tom/code/north/src/north/main.bclj"} (let [c ^{:line 659 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-i idx te today before?)]
  ^{:line 660 :file "/home/tom/code/north/src/north/main.bclj"} (->JThread ^{:line 660 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) ^{:line 660 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx te) c ^{:line 660 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-emoji idx c))))

^{:line 668 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ready-curated-tes [idx ^String today before? ^Boolean all?]
  ^{:line 669 :file "/home/tom/code/north/src/north/main.bclj"} (let [raw ^{:line 669 :file "/home/tom/code/north/src/north/main.bclj"} (proj/ready idx today before?)
   rs ^{:line 670 :file "/home/tom/code/north/src/north/main.bclj"} (if all? raw ^{:line 670 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 670 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 670 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 670 :file "/home/tom/code/north/src/north/main.bclj"} (kind-of idx te) "thread")) raw))
   ranked ^{:line 671 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 671 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 671 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 671 :file "/home/tom/code/north/src/north/main.bclj"} (- 0 ^{:line 671 :file "/home/tom/code/north/src/north/main.bclj"} (proj/leverage-score idx te))) rs))]
  ^{:line 672 :file "/home/tom/code/north/src/north/main.bclj"} (if all? ranked ^{:line 672 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 672 :file "/home/tom/code/north/src/north/main.bclj"} (take 15 ranked)))))

^{:line 674 :file "/home/tom/code/north/src/north/main.bclj"} (defn- board-curated-tes [idx ^String today before? ^Boolean all?]
  ^{:line 675 :file "/home/tom/code/north/src/north/main.bclj"} (let [nonterm ^{:line 675 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 675 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 675 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 675 :file "/home/tom/code/north/src/north/main.bclj"} (proj/terminal-i? idx te))) ^{:line 676 :file "/home/tom/code/north/src/north/main.bclj"} (proj/work-thread-ids-i idx))]
  ^{:line 677 :file "/home/tom/code/north/src/north/main.bclj"} (if all? nonterm ^{:line 682 :file "/home/tom/code/north/src/north/main.bclj"} (let [threads ^{:line 682 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 682 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 682 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 682 :file "/home/tom/code/north/src/north/main.bclj"} (kind-of idx te) "thread")) nonterm)
   now-secs ^{:line 683 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds ^{:line 683 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/now-iso))
   window-secs ^{:line 684 :file "/home/tom/code/north/src/north/main.bclj"} (driver-stale-window-secs)
   active ^{:line 685 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 685 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 685 :file "/home/tom/code/north/src/north/main.bclj"} (driver-live? idx te now-secs window-secs)) ^{:line 686 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx threads today before? "active"))
   ready ^{:line 687 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 687 :file "/home/tom/code/north/src/north/main.bclj"} (take 15 ^{:line 687 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 687 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 687 :file "/home/tom/code/north/src/north/main.bclj"} (- 0 ^{:line 687 :file "/home/tom/code/north/src/north/main.bclj"} (proj/leverage-score idx te))) ^{:line 688 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx threads today before? "ready"))))]
  ^{:line 689 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 689 :file "/home/tom/code/north/src/north/main.bclj"} (concat active ready))))))

^{:line 691 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-json [^String log ^String what ^String arg ^Boolean all?]
  ^{:line 692 :file "/home/tom/code/north/src/north/main.bclj"} (let [facts ^{:line 692 :file "/home/tom/code/north/src/north/main.bclj"} (live-facts log)
   idx ^{:line 693 :file "/home/tom/code/north/src/north/main.bclj"} (k/build-index facts)
   today ^{:line 694 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/today-iso)
   before? fram.rt/str-lt?]
  ^{:line 696 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 697 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 697 :file "/home/tom/code/north/src/north/main.bclj"} (= what "board") ^{:line 697 :file "/home/tom/code/north/src/north/main.bclj"} (= what "plate")) ^{:line 698 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 698 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/to-json ^{:line 699 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 699 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 699 :file "/home/tom/code/north/src/north/main.bclj"} (jthread idx te today before?)) ^{:line 700 :file "/home/tom/code/north/src/north/main.bclj"} (board-curated-tes idx today before? all?))))
  ^{:line 701 :file "/home/tom/code/north/src/north/main.bclj"} (= what "ready") ^{:line 702 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 702 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/to-json ^{:line 702 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 702 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 702 :file "/home/tom/code/north/src/north/main.bclj"} (jthread idx te today before?)) ^{:line 703 :file "/home/tom/code/north/src/north/main.bclj"} (ready-curated-tes idx today before? all?))))
  ^{:line 704 :file "/home/tom/code/north/src/north/main.bclj"} (= what "blocked") ^{:line 705 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 705 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/to-json ^{:line 705 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 705 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 705 :file "/home/tom/code/north/src/north/main.bclj"} (jthread idx te today before?)) ^{:line 706 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 706 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 706 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 706 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-i idx te today before?) "blocked")) ^{:line 707 :file "/home/tom/code/north/src/north/main.bclj"} (proj/work-thread-ids-i idx)))))
  ^{:line 708 :file "/home/tom/code/north/src/north/main.bclj"} (= what "needs-review") ^{:line 712 :file "/home/tom/code/north/src/north/main.bclj"} (let [as ^{:line 712 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/read-log log)
   cidx ^{:line 713 :file "/home/tom/code/north/src/north/main.bclj"} (k/build-index ^{:line 713 :file "/home/tom/code/north/src/north/main.bclj"} (:facts ^{:line 713 :file "/home/tom/code/north/src/north/main.bclj"} (fold/fold as)))
   latest ^{:line 714 :file "/home/tom/code/north/src/north/main.bclj"} (fold/fold-latest as)
   today ^{:line 715 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/today-iso)
   reviews ^{:line 716 :file "/home/tom/code/north/src/north/main.bclj"} (stale/needs-review cidx latest today ^{:line 717 :file "/home/tom/code/north/src/north/main.bclj"} (fn [a b] ^{:line 717 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/str-lt? a b)))]
  ^{:line 718 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 718 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/to-json ^{:line 719 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 719 :file "/home/tom/code/north/src/north/main.bclj"} (fn [rv] ^{:line 720 :file "/home/tom/code/north/src/north/main.bclj"} (->JReview ^{:line 720 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 720 :file "/home/tom/code/north/src/north/main.bclj"} (:te rv)) ^{:line 720 :file "/home/tom/code/north/src/north/main.bclj"} (title-of cidx ^{:line 720 :file "/home/tom/code/north/src/north/main.bclj"} (:te rv)) ^{:line 720 :file "/home/tom/code/north/src/north/main.bclj"} (:pred rv) ^{:line 720 :file "/home/tom/code/north/src/north/main.bclj"} (:detail rv))) reviews))))
  ^{:line 722 :file "/home/tom/code/north/src/north/main.bclj"} (= what "clock-report") ^{:line 723 :file "/home/tom/code/north/src/north/main.bclj"} (let [rs ^{:line 723 :file "/home/tom/code/north/src/north/main.bclj"} (clk/rows idx ^{:line 724 :file "/home/tom/code/north/src/north/main.bclj"} (fn [s] ^{:line 724 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds s)) ^{:line 725 :file "/home/tom/code/north/src/north/main.bclj"} (fn [s] ^{:line 725 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/parse-int s)))
   cal ^{:line 726 :file "/home/tom/code/north/src/north/main.bclj"} (clk/calibration rs)]
  ^{:line 727 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 727 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/to-json ^{:line 728 :file "/home/tom/code/north/src/north/main.bclj"} (->JClockReport ^{:line 729 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 729 :file "/home/tom/code/north/src/north/main.bclj"} (fn [r] ^{:line 730 :file "/home/tom/code/north/src/north/main.bclj"} (->JClockRow ^{:line 730 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 730 :file "/home/tom/code/north/src/north/main.bclj"} (:te r)) ^{:line 730 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 730 :file "/home/tom/code/north/src/north/main.bclj"} (:te r)) ^{:line 730 :file "/home/tom/code/north/src/north/main.bclj"} (:est-h r) ^{:line 730 :file "/home/tom/code/north/src/north/main.bclj"} (:act-sec r) ^{:line 730 :file "/home/tom/code/north/src/north/main.bclj"} (:term r))) rs) ^{:line 732 :file "/home/tom/code/north/src/north/main.bclj"} (->JCalib ^{:line 732 :file "/home/tom/code/north/src/north/main.bclj"} (:pct cal) ^{:line 732 :file "/home/tom/code/north/src/north/main.bclj"} (:sample cal))))))
  ^{:line 733 :file "/home/tom/code/north/src/north/main.bclj"} (= what "show") ^{:line 734 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 734 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/to-json ^{:line 735 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 735 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 735 :file "/home/tom/code/north/src/north/main.bclj"} (->JFact ^{:line 735 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) ^{:line 735 :file "/home/tom/code/north/src/north/main.bclj"} (:r c))) ^{:line 736 :file "/home/tom/code/north/src/north/main.bclj"} (k/q-by-l facts ^{:line 736 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" arg)))))
  ^{:line 737 :file "/home/tom/code/north/src/north/main.bclj"} (= what "presentation") ^{:line 738 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 738 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/to-json ^{:line 739 :file "/home/tom/code/north/src/north/main.bclj"} (->JPresentation ^{:line 739 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-emoji idx "active") ^{:line 739 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-emoji idx "ready") ^{:line 740 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-emoji idx "blocked") ^{:line 740 :file "/home/tom/code/north/src/north/main.bclj"} (proj/condition-emoji idx "draft"))))
  :else ^{:line 741 :file "/home/tom/code/north/src/north/main.bclj"} (println "usage: json board|ready|blocked|needs-review|clock-report|show <id>|presentation"))))

^{:line 743 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-needs-review [^String log]
  ^{:line 744 :file "/home/tom/code/north/src/north/main.bclj"} (let [as ^{:line 744 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/read-log log)
   idx ^{:line 745 :file "/home/tom/code/north/src/north/main.bclj"} (k/build-index ^{:line 745 :file "/home/tom/code/north/src/north/main.bclj"} (:facts ^{:line 745 :file "/home/tom/code/north/src/north/main.bclj"} (fold/fold as)))
   latest ^{:line 746 :file "/home/tom/code/north/src/north/main.bclj"} (fold/fold-latest as)
   today ^{:line 747 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/today-iso)
   reviews ^{:line 748 :file "/home/tom/code/north/src/north/main.bclj"} (stale/needs-review idx latest today ^{:line 749 :file "/home/tom/code/north/src/north/main.bclj"} (fn [a b] ^{:line 749 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/str-lt? a b)))
   promo ^{:line 750 :file "/home/tom/code/north/src/north/main.bclj"} (stale/promotable idx)]
  ^{:line 751 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 751 :file "/home/tom/code/north/src/north/main.bclj"} (str "NEEDS REVIEW — " ^{:line 751 :file "/home/tom/code/north/src/north/main.bclj"} (count reviews) " judgment(s) whose inputs moved (" today ")"))
  ^{:line 752 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [rv reviews]
  ^{:line 753 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 753 :file "/home/tom/code/north/src/north/main.bclj"} (str "  [" ^{:line 753 :file "/home/tom/code/north/src/north/main.bclj"} (:pred rv) "] " ^{:line 753 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 753 :file "/home/tom/code/north/src/north/main.bclj"} (:te rv)) "  " ^{:line 753 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 753 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 753 :file "/home/tom/code/north/src/north/main.bclj"} (:te rv)) 44)))
  ^{:line 754 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 754 :file "/home/tom/code/north/src/north/main.bclj"} (str "      " ^{:line 754 :file "/home/tom/code/north/src/north/main.bclj"} (:detail rv))))
  ^{:line 755 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 755 :file "/home/tom/code/north/src/north/main.bclj"} (str "\nPROMOTABLE — " ^{:line 755 :file "/home/tom/code/north/src/north/main.bclj"} (count promo) " uncommitted draft(s) that grew real structure"))
  ^{:line 756 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [te promo]
  ^{:line 757 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 757 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 757 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) "  " ^{:line 757 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 757 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx te) 52))))))

^{:line 760 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String fmt-hm [secs]
  ^{:line 761 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 761 :file "/home/tom/code/north/src/north/main.bclj"} (quot secs 3600) "h " ^{:line 761 :file "/home/tom/code/north/src/north/main.bclj"} (quot ^{:line 761 :file "/home/tom/code/north/src/north/main.bclj"} (mod secs 3600) 60) "m"))

^{:line 763 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String session-thread [idx ^String sess]
  ^{:line 764 :file "/home/tom/code/north/src/north/main.bclj"} (let [t ^{:line 764 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx sess "session_of")]
  ^{:line 764 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 764 :file "/home/tom/code/north/src/north/main.bclj"} (some? t) t "")))

^{:line 766 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String fresh-sid [idx ^String seed]
  ^{:line 767 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 767 :file "/home/tom/code/north/src/north/main.bclj"} (k/vec-contains? ^{:line 767 :file "/home/tom/code/north/src/north/main.bclj"} (:subjects idx) ^{:line 767 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" seed)) ^{:line 768 :file "/home/tom/code/north/src/north/main.bclj"} (fresh-sid idx ^{:line 768 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/bump-id seed)) seed))

^{:line 775 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String agent-id []
  ^{:line 776 :file "/home/tom/code/north/src/north/main.bclj"} (let [a ^{:line 776 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/getenv-or "NORTH_AGENT_ID" "")]
  ^{:line 777 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 777 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 777 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? a)) a ^{:line 779 :file "/home/tom/code/north/src/north/main.bclj"} (let [b ^{:line 779 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/getenv-or "AGENT_ID" "")]
  ^{:line 780 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 780 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 780 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? b)) b "user")))))

^{:line 782 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-clock-start [^String log ^String id]
  ^{:line 783 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 783 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   te ^{:line 784 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" id)
   me ^{:line 785 :file "/home/tom/code/north/src/north/main.bclj"} (agent-id)
   run ^{:line 786 :file "/home/tom/code/north/src/north/main.bclj"} (clk/running-session-for idx me)]
  ^{:line 787 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 788 :file "/home/tom/code/north/src/north/main.bclj"} (nil? ^{:line 788 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "title")) ^{:line 788 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 788 :file "/home/tom/code/north/src/north/main.bclj"} (str "no such thread: " id))
  ^{:line 789 :file "/home/tom/code/north/src/north/main.bclj"} (some? run) ^{:line 790 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 790 :file "/home/tom/code/north/src/north/main.bclj"} (str "already clocked in on " ^{:line 790 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 790 :file "/home/tom/code/north/src/north/main.bclj"} (session-thread idx run)) " (session " ^{:line 791 :file "/home/tom/code/north/src/north/main.bclj"} (short-id run) ", agent " me ") — `clock stop` first"))
  :else ^{:line 793 :file "/home/tom/code/north/src/north/main.bclj"} (let [port ^{:line 793 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-port)]
  ^{:line 794 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 794 :file "/home/tom/code/north/src/north/main.bclj"} (< ^{:line 794 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-version port) 0) ^{:line 795 :file "/home/tom/code/north/src/north/main.bclj"} (println "no coordinator on 127.0.0.1:7977 — run `north up`") ^{:line 796 :file "/home/tom/code/north/src/north/main.bclj"} (let [sid ^{:line 796 :file "/home/tom/code/north/src/north/main.bclj"} (fresh-sid idx ^{:line 796 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/now-id))
   ssub ^{:line 797 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" sid)
   now ^{:line 798 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/now-iso)
   r1 ^{:line 799 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port "assert" ssub "session_of" te 5)
   r2 ^{:line 800 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port "assert" ssub "start_time" now 5)
   r3 ^{:line 801 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port "assert" ssub "clocked_by" me 5)]
  ^{:line 802 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 802 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 802 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? r1 "ok:") ^{:line 803 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 803 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? r2 "ok:") ^{:line 803 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? r3 "ok:"))) ^{:line 804 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 804 :file "/home/tom/code/north/src/north/main.bclj"} (str "clocked in on " id " at " now "  (session " sid ", agent " me ")")) ^{:line 805 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 805 :file "/home/tom/code/north/src/north/main.bclj"} (str "clock start FAILED to record (" r1 "/" r2 "/" r3 ") — retry")))))))))

^{:line 807 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-clock-stop [^String log]
  ^{:line 808 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 808 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   me ^{:line 809 :file "/home/tom/code/north/src/north/main.bclj"} (agent-id)
   run ^{:line 810 :file "/home/tom/code/north/src/north/main.bclj"} (clk/running-session-for idx me)
   port ^{:line 811 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-port)]
  ^{:line 812 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 813 :file "/home/tom/code/north/src/north/main.bclj"} (nil? run) ^{:line 813 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 813 :file "/home/tom/code/north/src/north/main.bclj"} (str "not clocked in (agent " me ")"))
  ^{:line 814 :file "/home/tom/code/north/src/north/main.bclj"} (< ^{:line 814 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-version port) 0) ^{:line 815 :file "/home/tom/code/north/src/north/main.bclj"} (println "no coordinator on 127.0.0.1:7977 — run `north up` (still clocked in)")
  :else ^{:line 817 :file "/home/tom/code/north/src/north/main.bclj"} (let [now ^{:line 817 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/now-iso)
   st ^{:line 818 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx run "start_time")
   te ^{:line 819 :file "/home/tom/code/north/src/north/main.bclj"} (session-thread idx run)
   dur ^{:line 820 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 820 :file "/home/tom/code/north/src/north/main.bclj"} (some? st) ^{:line 820 :file "/home/tom/code/north/src/north/main.bclj"} (- ^{:line 820 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds now) ^{:line 820 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds st)) 0)
   resp ^{:line 821 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port "assert" run "end_time" now 5)]
  ^{:line 822 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 822 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? resp "ok:") ^{:line 823 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 823 :file "/home/tom/code/north/src/north/main.bclj"} (str "clocked out of " ^{:line 823 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) " — this session " ^{:line 823 :file "/home/tom/code/north/src/north/main.bclj"} (fmt-hm dur))) ^{:line 824 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 824 :file "/home/tom/code/north/src/north/main.bclj"} (str "clock stop FAILED to record end_time (" resp ") — still clocked in, retry")))))))

^{:line 830 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-clock-orphan [^String log ^String agent]
  ^{:line 831 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 831 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   run ^{:line 832 :file "/home/tom/code/north/src/north/main.bclj"} (clk/running-session-for idx agent)
   port ^{:line 833 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-port)]
  ^{:line 834 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 835 :file "/home/tom/code/north/src/north/main.bclj"} (nil? run) ^{:line 835 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 835 :file "/home/tom/code/north/src/north/main.bclj"} (str "no open session for agent " agent " — nothing to orphan"))
  ^{:line 836 :file "/home/tom/code/north/src/north/main.bclj"} (< ^{:line 836 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-version port) 0) ^{:line 837 :file "/home/tom/code/north/src/north/main.bclj"} (println "no coordinator on 127.0.0.1:7977 — run `north up`")
  :else ^{:line 839 :file "/home/tom/code/north/src/north/main.bclj"} (let [now ^{:line 839 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/now-iso)
   te ^{:line 840 :file "/home/tom/code/north/src/north/main.bclj"} (session-thread idx run)
   r1 ^{:line 841 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port "assert" run "end_time" now 5)
   r2 ^{:line 842 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port "assert" run "clock_orphaned" "true" 5)]
  ^{:line 843 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 843 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 843 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? r1 "ok:") ^{:line 843 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? r2 "ok:")) ^{:line 844 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 844 :file "/home/tom/code/north/src/north/main.bclj"} (str "orphan-closed " ^{:line 844 :file "/home/tom/code/north/src/north/main.bclj"} (short-id run) " on " ^{:line 844 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) " at " now "  (agent " agent ", clock_orphaned)")) ^{:line 846 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 846 :file "/home/tom/code/north/src/north/main.bclj"} (str "clock orphan FAILED (" r1 "/" r2 ") — retry")))))))

^{:line 848 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-clock-status [^String log]
  ^{:line 849 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 849 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   me ^{:line 850 :file "/home/tom/code/north/src/north/main.bclj"} (agent-id)
   run ^{:line 851 :file "/home/tom/code/north/src/north/main.bclj"} (clk/running-session-for idx me)
   othern ^{:line 852 :file "/home/tom/code/north/src/north/main.bclj"} (let [n ^{:line 852 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 852 :file "/home/tom/code/north/src/north/main.bclj"} (clk/open-sessions idx))]
  ^{:line 852 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 852 :file "/home/tom/code/north/src/north/main.bclj"} (some? run) ^{:line 852 :file "/home/tom/code/north/src/north/main.bclj"} (- n 1) n))]
  ^{:line 853 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 853 :file "/home/tom/code/north/src/north/main.bclj"} (nil? run) ^{:line 854 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 854 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 854 :file "/home/tom/code/north/src/north/main.bclj"} (str "not clocked in (agent " me ")"))
  ^{:line 855 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 855 :file "/home/tom/code/north/src/north/main.bclj"} (> othern 0) ^{:line 855 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 856 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 856 :file "/home/tom/code/north/src/north/main.bclj"} (str "  (" othern " other agent session(s) open)"))))) ^{:line 857 :file "/home/tom/code/north/src/north/main.bclj"} (let [now ^{:line 857 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/now-iso)
   st ^{:line 858 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx run "start_time")
   te ^{:line 859 :file "/home/tom/code/north/src/north/main.bclj"} (session-thread idx run)
   dur ^{:line 860 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 860 :file "/home/tom/code/north/src/north/main.bclj"} (some? st) ^{:line 860 :file "/home/tom/code/north/src/north/main.bclj"} (- ^{:line 860 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds now) ^{:line 860 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds st)) 0)]
  ^{:line 861 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 861 :file "/home/tom/code/north/src/north/main.bclj"} (str "clocked in on " ^{:line 861 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) "  " ^{:line 861 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 861 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx te) 40) "  (agent " me ")"))
  ^{:line 862 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 862 :file "/home/tom/code/north/src/north/main.bclj"} (str "  since " ^{:line 862 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 862 :file "/home/tom/code/north/src/north/main.bclj"} (some? st) st "?") "  (" ^{:line 862 :file "/home/tom/code/north/src/north/main.bclj"} (fmt-hm dur) " elapsed)"))
  ^{:line 863 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 863 :file "/home/tom/code/north/src/north/main.bclj"} (> othern 0) ^{:line 863 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 864 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 864 :file "/home/tom/code/north/src/north/main.bclj"} (str "  + " othern " other agent session(s) open"))))))))

^{:line 866 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-clock-report [^String log]
  ^{:line 867 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 867 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   rs ^{:line 868 :file "/home/tom/code/north/src/north/main.bclj"} (clk/rows idx ^{:line 869 :file "/home/tom/code/north/src/north/main.bclj"} (fn [s] ^{:line 869 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds s)) ^{:line 870 :file "/home/tom/code/north/src/north/main.bclj"} (fn [s] ^{:line 870 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/parse-int s)))
   cal ^{:line 871 :file "/home/tom/code/north/src/north/main.bclj"} (clk/calibration rs)]
  ^{:line 872 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 872 :file "/home/tom/code/north/src/north/main.bclj"} (str "TIME LOGGED — estimate vs actual (" ^{:line 872 :file "/home/tom/code/north/src/north/main.bclj"} (count rs) " thread(s))"))
  ^{:line 873 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [r rs]
  ^{:line 874 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 874 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 874 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 874 :file "/home/tom/code/north/src/north/main.bclj"} (:te r)) "  est " ^{:line 874 :file "/home/tom/code/north/src/north/main.bclj"} (:est-h r) "h  actual " ^{:line 874 :file "/home/tom/code/north/src/north/main.bclj"} (fmt-hm ^{:line 874 :file "/home/tom/code/north/src/north/main.bclj"} (:act-sec r)) "  " ^{:line 875 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 875 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 875 :file "/home/tom/code/north/src/north/main.bclj"} (:te r)) 38))))
  ^{:line 876 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 876 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 876 :file "/home/tom/code/north/src/north/main.bclj"} (:sample cal) 0) ^{:line 877 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 877 :file "/home/tom/code/north/src/north/main.bclj"} (str "\nCALIBRATION — across " ^{:line 877 :file "/home/tom/code/north/src/north/main.bclj"} (:sample cal) " done thread(s) with both: actuals ran " ^{:line 878 :file "/home/tom/code/north/src/north/main.bclj"} (:pct cal) "% of estimate" ^{:line 879 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 879 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 879 :file "/home/tom/code/north/src/north/main.bclj"} (:pct cal) 100) " (you under-estimate)" " (you over-estimate)"))) ^{:line 880 :file "/home/tom/code/north/src/north/main.bclj"} (println "\nCALIBRATION — not enough completed estimate+actual data yet"))))

^{:line 882 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-clock-sync [^String log]
  ^{:line 883 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 883 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   dir ^{:line 884 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/time-dir)
   sessions ^{:line 885 :file "/home/tom/code/north/src/north/main.bclj"} (clk/syncable-sessions idx)
   port ^{:line 886 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-port)]
  ^{:line 887 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 888 :file "/home/tom/code/north/src/north/main.bclj"} (empty? sessions) ^{:line 888 :file "/home/tom/code/north/src/north/main.bclj"} (println "nothing to sync — no closed, unsynced sessions")
  ^{:line 889 :file "/home/tom/code/north/src/north/main.bclj"} (< ^{:line 889 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-version port) 0) ^{:line 890 :file "/home/tom/code/north/src/north/main.bclj"} (println "no coordinator on 127.0.0.1:7977 — run `north up` (sync records clockify_id, so it must be up first)")
  :else ^{:line 892 :file "/home/tom/code/north/src/north/main.bclj"} (let [ws ^{:line 892 :file "/home/tom/code/north/src/north/main.bclj"} (cf/default-workspace)]
  ^{:line 893 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 893 :file "/home/tom/code/north/src/north/main.bclj"} (str "syncing " ^{:line 893 :file "/home/tom/code/north/src/north/main.bclj"} (count sessions) " session(s) to clockify (workspace " ws ")"))
  ^{:line 894 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [s sessions]
  ^{:line 895 :file "/home/tom/code/north/src/north/main.bclj"} (let [te ^{:line 895 :file "/home/tom/code/north/src/north/main.bclj"} (session-thread idx s)
   owner ^{:line 896 :file "/home/tom/code/north/src/north/main.bclj"} (let [o ^{:line 896 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "owner")]
  ^{:line 896 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 896 :file "/home/tom/code/north/src/north/main.bclj"} (some? o) o "personal"))
   proj ^{:line 897 :file "/home/tom/code/north/src/north/main.bclj"} (cf/project-for dir owner)
   st ^{:line 898 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx s "start_time")
   en ^{:line 899 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx s "end_time")]
  ^{:line 900 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 901 :file "/home/tom/code/north/src/north/main.bclj"} (nil? proj) ^{:line 902 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 902 :file "/home/tom/code/north/src/north/main.bclj"} (str "  – skip " ^{:line 902 :file "/home/tom/code/north/src/north/main.bclj"} (short-id s) "  (owner '" owner "' unmapped — `clock map " owner " <project-id>`)"))
  ^{:line 903 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 903 :file "/home/tom/code/north/src/north/main.bclj"} (nil? st) ^{:line 903 :file "/home/tom/code/north/src/north/main.bclj"} (nil? en)) ^{:line 904 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 904 :file "/home/tom/code/north/src/north/main.bclj"} (str "  ! skip " ^{:line 904 :file "/home/tom/code/north/src/north/main.bclj"} (short-id s) "  (missing start/end)"))
  :else ^{:line 906 :file "/home/tom/code/north/src/north/main.bclj"} (let [cid ^{:line 906 :file "/home/tom/code/north/src/north/main.bclj"} (cf/create-entry ws proj st en ^{:line 906 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx te))]
  ^{:line 907 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 907 :file "/home/tom/code/north/src/north/main.bclj"} (= cid "") ^{:line 908 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 908 :file "/home/tom/code/north/src/north/main.bclj"} (str "  ! " ^{:line 908 :file "/home/tom/code/north/src/north/main.bclj"} (short-id s) "  (clockify returned no id)")) ^{:line 909 :file "/home/tom/code/north/src/north/main.bclj"} (let [wb ^{:line 909 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port "assert" s "clockify_id" cid 5)]
  ^{:line 910 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 910 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? wb "ok:") ^{:line 911 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 911 :file "/home/tom/code/north/src/north/main.bclj"} (str "  ✓ " ^{:line 911 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te) "  " st " → " en "  (clockify " cid ")")) ^{:line 912 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 912 :file "/home/tom/code/north/src/north/main.bclj"} (str "  !! " ^{:line 912 :file "/home/tom/code/north/src/north/main.bclj"} (short-id s) " PUSHED to clockify (" cid ") but failed to record it (" wb ") — set manually to avoid a double-push: tell " ^{:line 913 :file "/home/tom/code/north/src/north/main.bclj"} (short-id s) " clockify_id " cid)))))))))
  ^{:line 914 :file "/home/tom/code/north/src/north/main.bclj"} (println "done.")))))

^{:line 916 :file "/home/tom/code/north/src/north/main.bclj"} (defn- clock-window [^String log prefixes ^String label]
  ^{:line 917 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 917 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   rs ^{:line 918 :file "/home/tom/code/north/src/north/main.bclj"} (clk/logged-rows idx prefixes ^{:line 918 :file "/home/tom/code/north/src/north/main.bclj"} (fn [s] ^{:line 918 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/iso-to-seconds s)))
   total ^{:line 919 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 919 :file "/home/tom/code/north/src/north/main.bclj"} (fn [m r] ^{:line 919 :file "/home/tom/code/north/src/north/main.bclj"} (+ m ^{:line 919 :file "/home/tom/code/north/src/north/main.bclj"} (:act-sec r))) 0 rs)]
  ^{:line 920 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 920 :file "/home/tom/code/north/src/north/main.bclj"} (str "LOGGED " label " — " ^{:line 920 :file "/home/tom/code/north/src/north/main.bclj"} (fmt-hm total) " across " ^{:line 920 :file "/home/tom/code/north/src/north/main.bclj"} (count rs) " thread(s)"))
  ^{:line 921 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [r rs]
  ^{:line 922 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 922 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 922 :file "/home/tom/code/north/src/north/main.bclj"} (fmt-hm ^{:line 922 :file "/home/tom/code/north/src/north/main.bclj"} (:act-sec r)) "  " ^{:line 922 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 922 :file "/home/tom/code/north/src/north/main.bclj"} (:te r)) "  " ^{:line 922 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 922 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 922 :file "/home/tom/code/north/src/north/main.bclj"} (:te r)) 40))))))

^{:line 924 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-clock-today [^String log]
  ^{:line 925 :file "/home/tom/code/north/src/north/main.bclj"} (clock-window log ^{:line 925 :file "/home/tom/code/north/src/north/main.bclj"} (conj ^{:line 925 :file "/home/tom/code/north/src/north/main.bclj"} [] ^{:line 925 :file "/home/tom/code/north/src/north/main.bclj"} (subs ^{:line 925 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/now-iso) 0 10)) "today"))

^{:line 927 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-clock-week [^String log]
  ^{:line 928 :file "/home/tom/code/north/src/north/main.bclj"} (clock-window log ^{:line 928 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/this-week-dates) "this week"))

^{:line 935 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord Probe [up serving fresh port status daemon-v log-v log-facts idx stale hand log-behind tombstoned])

(defn probe-up [r] (:up r))

(defn probe-serving [r] (:serving r))

(defn probe-fresh [r] (:fresh r))

(defn probe-port [r] (:port r))

(defn probe-status [r] (:status r))

(defn probe-daemon-v [r] (:daemon-v r))

(defn probe-log-v [r] (:log-v r))

(defn probe-log-facts [r] (:log-facts r))

(defn probe-idx [r] (:idx r))

(defn probe-stale [r] (:stale r))

(defn probe-hand [r] (:hand r))

(defn probe-log-behind [r] (:log-behind r))

(defn probe-tombstoned [r] (:tombstoned r))

^{:line 950 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^Boolean stale-projection? [idx c]
  ^{:line 951 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 951 :file "/home/tom/code/north/src/north/main.bclj"} (k/single? ^{:line 951 :file "/home/tom/code/north/src/north/main.bclj"} (:p c)) ^{:line 952 :file "/home/tom/code/north/src/north/main.bclj"} (let [v ^{:line 952 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx ^{:line 952 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) ^{:line 952 :file "/home/tom/code/north/src/north/main.bclj"} (:p c))]
  ^{:line 953 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 953 :file "/home/tom/code/north/src/north/main.bclj"} (some? v) ^{:line 953 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 953 :file "/home/tom/code/north/src/north/main.bclj"} (= v ^{:line 953 :file "/home/tom/code/north/src/north/main.bclj"} (:r c)))))))

^{:line 955 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^Probe probe [^String threads-dir ^String log]
  ^{:line 956 :file "/home/tom/code/north/src/north/main.bclj"} (let [port ^{:line 956 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-port)
   status ^{:line 957 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-status port)
   up ^{:line 958 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 958 :file "/home/tom/code/north/src/north/main.bclj"} (= status "down"))
   serving ^{:line 959 :file "/home/tom/code/north/src/north/main.bclj"} (str/includes? status log)
   ops ^{:line 964 :file "/home/tom/code/north/src/north/main.bclj"} (read-logs-merged log)
   f ^{:line 965 :file "/home/tom/code/north/src/north/main.bclj"} (fold/fold ops)
   log-facts ^{:line 966 :file "/home/tom/code/north/src/north/main.bclj"} (:facts f)
   log-v ^{:line 967 :file "/home/tom/code/north/src/north/main.bclj"} (:version f)
   daemon-v ^{:line 968 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-version port)
   fresh ^{:line 972 :file "/home/tom/code/north/src/north/main.bclj"} (>= daemon-v log-v)
   idx ^{:line 973 :file "/home/tom/code/north/src/north/main.bclj"} (k/build-index log-facts)
   file-facts ^{:line 974 :file "/home/tom/code/north/src/north/main.bclj"} (:facts ^{:line 974 :file "/home/tom/code/north/src/north/main.bclj"} (fold/fold ^{:line 974 :file "/home/tom/code/north/src/north/main.bclj"} (imp/load-corpus threads-dir)))
   thread-log ^{:line 978 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 978 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 978 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 978 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx ^{:line 978 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) "title"))) log-facts)
   tl-sigs ^{:line 979 :file "/home/tom/code/north/src/north/main.bclj"} (sig-member-map thread-log)
   file-sigs ^{:line 980 :file "/home/tom/code/north/src/north/main.bclj"} (sig-member-map file-facts)
   file-ahead ^{:line 981 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 981 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 981 :file "/home/tom/code/north/src/north/main.bclj"} (nil? ^{:line 981 :file "/home/tom/code/north/src/north/main.bclj"} (get tl-sigs ^{:line 981 :file "/home/tom/code/north/src/north/main.bclj"} (fact-sig c)))) file-facts)
   log-behind ^{:line 982 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 982 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 982 :file "/home/tom/code/north/src/north/main.bclj"} (nil? ^{:line 982 :file "/home/tom/code/north/src/north/main.bclj"} (get file-sigs ^{:line 982 :file "/home/tom/code/north/src/north/main.bclj"} (fact-sig c)))) thread-log)
   stale ^{:line 983 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 983 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 983 :file "/home/tom/code/north/src/north/main.bclj"} (stale-projection? idx c)) file-ahead)
   non-stale ^{:line 987 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 987 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 987 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 987 :file "/home/tom/code/north/src/north/main.bclj"} (stale-projection? idx c))) file-ahead)
   tomb-sigs ^{:line 988 :file "/home/tom/code/north/src/north/main.bclj"} (retracted-sigs ops)
   tombstoned ^{:line 989 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 989 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 989 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 989 :file "/home/tom/code/north/src/north/main.bclj"} (get tomb-sigs ^{:line 989 :file "/home/tom/code/north/src/north/main.bclj"} (fact-sig c)))) non-stale)
   hand ^{:line 990 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 990 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 990 :file "/home/tom/code/north/src/north/main.bclj"} (nil? ^{:line 990 :file "/home/tom/code/north/src/north/main.bclj"} (get tomb-sigs ^{:line 990 :file "/home/tom/code/north/src/north/main.bclj"} (fact-sig c)))) non-stale)]
  ^{:line 991 :file "/home/tom/code/north/src/north/main.bclj"} (->Probe up serving fresh port status daemon-v log-v log-facts idx stale hand log-behind tombstoned)))

^{:line 995 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^Boolean safe? [^Probe p]
  ^{:line 995 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 995 :file "/home/tom/code/north/src/north/main.bclj"} (:up p) ^{:line 995 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 995 :file "/home/tom/code/north/src/north/main.bclj"} (:serving p) ^{:line 995 :file "/home/tom/code/north/src/north/main.bclj"} (:fresh p))))

^{:line 997 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String safety-line [^Probe p]
  ^{:line 998 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 998 :file "/home/tom/code/north/src/north/main.bclj"} (safe? p) "healthy: tell/untell + warm reads are safe" ^{:line 1000 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 1001 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1001 :file "/home/tom/code/north/src/north/main.bclj"} (:up p)) ^{:line 1001 :file "/home/tom/code/north/src/north/main.bclj"} (str "DEGRADED: coordinator DOWN on 127.0.0.1:" ^{:line 1001 :file "/home/tom/code/north/src/north/main.bclj"} (:port p) " — run `north up` (writes won't serialize)")
  ^{:line 1002 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1002 :file "/home/tom/code/north/src/north/main.bclj"} (:serving p)) ^{:line 1002 :file "/home/tom/code/north/src/north/main.bclj"} (str "DEGRADED: daemon not serving the canonical log — status: " ^{:line 1002 :file "/home/tom/code/north/src/north/main.bclj"} (:status p))
  :else ^{:line 1003 :file "/home/tom/code/north/src/north/main.bclj"} (str "DEGRADED: daemon STALE (loaded v" ^{:line 1003 :file "/home/tom/code/north/src/north/main.bclj"} (:daemon-v p) " behind log v" ^{:line 1003 :file "/home/tom/code/north/src/north/main.bclj"} (:log-v p) ") — the log changed out-of-band; restart it + `north up`"))))

^{:line 1007 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String hygiene-line [^Probe p]
  ^{:line 1008 :file "/home/tom/code/north/src/north/main.bclj"} (let [ns ^{:line 1008 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1008 :file "/home/tom/code/north/src/north/main.bclj"} (:stale p))
   nh ^{:line 1008 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1008 :file "/home/tom/code/north/src/north/main.bclj"} (:hand p))
   nb ^{:line 1008 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1008 :file "/home/tom/code/north/src/north/main.bclj"} (:log-behind p))
   nt ^{:line 1008 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1008 :file "/home/tom/code/north/src/north/main.bclj"} (:tombstoned p))]
  ^{:line 1009 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1009 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1009 :file "/home/tom/code/north/src/north/main.bclj"} (= ns 0) ^{:line 1009 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1009 :file "/home/tom/code/north/src/north/main.bclj"} (= nh 0) ^{:line 1009 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1009 :file "/home/tom/code/north/src/north/main.bclj"} (= nb 0) ^{:line 1009 :file "/home/tom/code/north/src/north/main.bclj"} (= nt 0)))) "" ^{:line 1011 :file "/home/tom/code/north/src/north/main.bclj"} (str "hygiene: " ^{:line 1011 :file "/home/tom/code/north/src/north/main.bclj"} (+ ns ^{:line 1011 :file "/home/tom/code/north/src/north/main.bclj"} (+ nb nt)) " stale/lagging projection fact(s) — run `north heal`" ^{:line 1012 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1012 :file "/home/tom/code/north/src/north/main.bclj"} (> nh 0) ^{:line 1012 :file "/home/tom/code/north/src/north/main.bclj"} (str "; " nh " hand-edited fact(s) — reconcile via tell/import") "")))))

^{:line 1015 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-doctor [^String threads-dir ^String log]
  ^{:line 1016 :file "/home/tom/code/north/src/north/main.bclj"} (let [p ^{:line 1016 :file "/home/tom/code/north/src/north/main.bclj"} (probe threads-dir log)]
  ^{:line 1017 :file "/home/tom/code/north/src/north/main.bclj"} (println "north doctor")
  ^{:line 1019 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1019 :file "/home/tom/code/north/src/north/main.bclj"} (:up p) ^{:line 1020 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1021 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1021 :file "/home/tom/code/north/src/north/main.bclj"} (str "  [ok]    coordinator UP on 127.0.0.1:" ^{:line 1021 :file "/home/tom/code/north/src/north/main.bclj"} (:port p)))
  ^{:line 1022 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1022 :file "/home/tom/code/north/src/north/main.bclj"} (:serving p) ^{:line 1023 :file "/home/tom/code/north/src/north/main.bclj"} (println "  [ok]    serving the canonical log") ^{:line 1024 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1024 :file "/home/tom/code/north/src/north/main.bclj"} (str "  [WARN]  daemon is NOT serving " log " — status: " ^{:line 1024 :file "/home/tom/code/north/src/north/main.bclj"} (:status p))))
  ^{:line 1025 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1025 :file "/home/tom/code/north/src/north/main.bclj"} (:fresh p) ^{:line 1026 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1026 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 1026 :file "/home/tom/code/north/src/north/main.bclj"} (:daemon-v p) ^{:line 1026 :file "/home/tom/code/north/src/north/main.bclj"} (:log-v p)) ^{:line 1027 :file "/home/tom/code/north/src/north/main.bclj"} (println "  [ok]    daemon state matches the on-disk log") ^{:line 1028 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1028 :file "/home/tom/code/north/src/north/main.bclj"} (str "  [ok]    daemon current with the log (loaded v" ^{:line 1028 :file "/home/tom/code/north/src/north/main.bclj"} (:daemon-v p) " > log v" ^{:line 1029 :file "/home/tom/code/north/src/north/main.bclj"} (:log-v p) " — in-memory lease txs, never flat-logged)"))) ^{:line 1030 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1030 :file "/home/tom/code/north/src/north/main.bclj"} (str "  [WARN]  daemon is STALE (loaded v" ^{:line 1030 :file "/home/tom/code/north/src/north/main.bclj"} (:daemon-v p) " behind log v" ^{:line 1030 :file "/home/tom/code/north/src/north/main.bclj"} (:log-v p) ") — the log changed out-of-band; restart: kill it + `north up`")))) ^{:line 1032 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1032 :file "/home/tom/code/north/src/north/main.bclj"} (str "  [DOWN]  no coordinator on 127.0.0.1:" ^{:line 1032 :file "/home/tom/code/north/src/north/main.bclj"} (:port p) " — writes won't serialize. Run `north up`.")))
  ^{:line 1033 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1033 :file "/home/tom/code/north/src/north/main.bclj"} (safe? p) ^{:line 1034 :file "/home/tom/code/north/src/north/main.bclj"} (println "  => healthy: tell/untell + warm reads are safe") ^{:line 1035 :file "/home/tom/code/north/src/north/main.bclj"} (println "  => DEGRADED: fix the warnings above"))
  ^{:line 1037 :file "/home/tom/code/north/src/north/main.bclj"} (println "  hygiene:")
  ^{:line 1038 :file "/home/tom/code/north/src/north/main.bclj"} (let [ns ^{:line 1038 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1038 :file "/home/tom/code/north/src/north/main.bclj"} (:stale p))
   nh ^{:line 1038 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1038 :file "/home/tom/code/north/src/north/main.bclj"} (:hand p))
   nb ^{:line 1038 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1038 :file "/home/tom/code/north/src/north/main.bclj"} (:log-behind p))
   nt ^{:line 1038 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1038 :file "/home/tom/code/north/src/north/main.bclj"} (:tombstoned p))]
  ^{:line 1039 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1039 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1039 :file "/home/tom/code/north/src/north/main.bclj"} (= ns 0) ^{:line 1039 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1039 :file "/home/tom/code/north/src/north/main.bclj"} (= nh 0) ^{:line 1039 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1039 :file "/home/tom/code/north/src/north/main.bclj"} (= nb 0) ^{:line 1039 :file "/home/tom/code/north/src/north/main.bclj"} (= nt 0)))) ^{:line 1040 :file "/home/tom/code/north/src/north/main.bclj"} (println "    [ok]    files <-> fact log in sync") ^{:line 1041 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1042 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1042 :file "/home/tom/code/north/src/north/main.bclj"} (> ns 0) ^{:line 1042 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1043 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1043 :file "/home/tom/code/north/src/north/main.bclj"} (str "    " ns " stale projection fact(s) — run `north heal`"))))
  ^{:line 1044 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1044 :file "/home/tom/code/north/src/north/main.bclj"} (> nt 0) ^{:line 1044 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1045 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1045 :file "/home/tom/code/north/src/north/main.bclj"} (str "    " nt " retracted-but-still-in-file fact(s) (tombstones) — run `north heal`"))))
  ^{:line 1046 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1046 :file "/home/tom/code/north/src/north/main.bclj"} (> nh 0) ^{:line 1046 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1047 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1047 :file "/home/tom/code/north/src/north/main.bclj"} (str "    " nh " genuinely-new file fact(s) (hand edits) — reconcile via tell or import"))))
  ^{:line 1048 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1048 :file "/home/tom/code/north/src/north/main.bclj"} (> nb 0) ^{:line 1048 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1049 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1049 :file "/home/tom/code/north/src/north/main.bclj"} (str "    " nb " log fact(s) not yet in files — benign projection lag; run `north heal`")))))))))

^{:line 1054 :file "/home/tom/code/north/src/north/main.bclj"} (defn- distinct-ids [xs]
  ^{:line 1055 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1055 :file "/home/tom/code/north/src/north/main.bclj"} (fn [acc x] ^{:line 1056 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1056 :file "/home/tom/code/north/src/north/main.bclj"} (k/vec-contains? acc x) acc ^{:line 1056 :file "/home/tom/code/north/src/north/main.bclj"} (conj acc x))) ^{:line 1056 :file "/home/tom/code/north/src/north/main.bclj"} [] xs))

^{:line 1060 :file "/home/tom/code/north/src/north/main.bclj"} (defn- heal-targets [^Probe p]
  ^{:line 1061 :file "/home/tom/code/north/src/north/main.bclj"} (distinct-ids ^{:line 1061 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1061 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 1061 :file "/home/tom/code/north/src/north/main.bclj"} (:l c)) ^{:line 1062 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1062 :file "/home/tom/code/north/src/north/main.bclj"} (concat ^{:line 1062 :file "/home/tom/code/north/src/north/main.bclj"} (:stale p) ^{:line 1062 :file "/home/tom/code/north/src/north/main.bclj"} (:log-behind p) ^{:line 1062 :file "/home/tom/code/north/src/north/main.bclj"} (:tombstoned p))))))

^{:line 1065 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String file-subject [^String content]
  ^{:line 1066 :file "/home/tom/code/north/src/north/main.bclj"} (let [lines ^{:line 1066 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/split-on content "\n")
   n ^{:line 1067 :file "/home/tom/code/north/src/north/main.bclj"} (count lines)]
  ^{:line 1068 :file "/home/tom/code/north/src/north/main.bclj"} (loop [i 0]
  ^{:line 1069 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 1070 :file "/home/tom/code/north/src/north/main.bclj"} (>= i n) ""
  ^{:line 1071 :file "/home/tom/code/north/src/north/main.bclj"} (= "---" ^{:line 1071 :file "/home/tom/code/north/src/north/main.bclj"} (str/trim ^{:line 1071 :file "/home/tom/code/north/src/north/main.bclj"} (nth lines i))) ""
  ^{:line 1072 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? ^{:line 1072 :file "/home/tom/code/north/src/north/main.bclj"} (str/trim ^{:line 1072 :file "/home/tom/code/north/src/north/main.bclj"} (nth lines i)) "@") ^{:line 1072 :file "/home/tom/code/north/src/north/main.bclj"} (str/trim ^{:line 1072 :file "/home/tom/code/north/src/north/main.bclj"} (nth lines i))
  :else ^{:line 1073 :file "/home/tom/code/north/src/north/main.bclj"} (recur ^{:line 1073 :file "/home/tom/code/north/src/north/main.bclj"} (+ i 1))))))

^{:line 1076 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String basename [^String threads-dir ^String path]
  ^{:line 1077 :file "/home/tom/code/north/src/north/main.bclj"} (let [pre ^{:line 1077 :file "/home/tom/code/north/src/north/main.bclj"} (+ ^{:line 1077 :file "/home/tom/code/north/src/north/main.bclj"} (count threads-dir) 1)]
  ^{:line 1078 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1078 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 1078 :file "/home/tom/code/north/src/north/main.bclj"} (count path) pre) ^{:line 1078 :file "/home/tom/code/north/src/north/main.bclj"} (subs path pre) path)))

^{:line 1084 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String file-owner [ids ^String name]
  ^{:line 1085 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1085 :file "/home/tom/code/north/src/north/main.bclj"} (fn [best id] ^{:line 1086 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1086 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1086 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 1086 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? name ^{:line 1086 :file "/home/tom/code/north/src/north/main.bclj"} (str id "-")) ^{:line 1086 :file "/home/tom/code/north/src/north/main.bclj"} (= name ^{:line 1086 :file "/home/tom/code/north/src/north/main.bclj"} (str id ".md"))) ^{:line 1087 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 1087 :file "/home/tom/code/north/src/north/main.bclj"} (count id) ^{:line 1087 :file "/home/tom/code/north/src/north/main.bclj"} (count best))) id best)) "" ids))

^{:line 1091 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord FileInfo [path owner head])

(defn fileinfo-path [r] (:path r))

(defn fileinfo-owner [r] (:owner r))

(defn fileinfo-head [r] (:head r))

^{:line 1093 :file "/home/tom/code/north/src/north/main.bclj"} (defn- scan-files [^String threads-dir files ids]
  ^{:line 1094 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1094 :file "/home/tom/code/north/src/north/main.bclj"} (fn [path] ^{:line 1095 :file "/home/tom/code/north/src/north/main.bclj"} (->FileInfo path ^{:line 1095 :file "/home/tom/code/north/src/north/main.bclj"} (file-owner ids ^{:line 1095 :file "/home/tom/code/north/src/north/main.bclj"} (basename threads-dir path)) ^{:line 1096 :file "/home/tom/code/north/src/north/main.bclj"} (file-subject ^{:line 1096 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/slurp path)))) files))

^{:line 1100 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String path-of [scan ^String id]
  ^{:line 1101 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1101 :file "/home/tom/code/north/src/north/main.bclj"} (fn [acc fi] ^{:line 1102 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1102 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1102 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? acc) ^{:line 1102 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 1102 :file "/home/tom/code/north/src/north/main.bclj"} (:owner fi) id)) ^{:line 1102 :file "/home/tom/code/north/src/north/main.bclj"} (:path fi) acc)) "" scan))

^{:line 1108 :file "/home/tom/code/north/src/north/main.bclj"} (defn- broken-head-ids [scan idx]
  ^{:line 1109 :file "/home/tom/code/north/src/north/main.bclj"} (distinct-ids ^{:line 1110 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1110 :file "/home/tom/code/north/src/north/main.bclj"} (fn [acc fi] ^{:line 1111 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1111 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1111 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1111 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? ^{:line 1111 :file "/home/tom/code/north/src/north/main.bclj"} (:owner fi))) ^{:line 1112 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1112 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1112 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 1112 :file "/home/tom/code/north/src/north/main.bclj"} (:head fi) ^{:line 1112 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" ^{:line 1112 :file "/home/tom/code/north/src/north/main.bclj"} (:owner fi)))) ^{:line 1113 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 1113 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx ^{:line 1113 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" ^{:line 1113 :file "/home/tom/code/north/src/north/main.bclj"} (:owner fi)) "title")))) ^{:line 1114 :file "/home/tom/code/north/src/north/main.bclj"} (conj acc ^{:line 1114 :file "/home/tom/code/north/src/north/main.bclj"} (:owner fi)) acc)) ^{:line 1116 :file "/home/tom/code/north/src/north/main.bclj"} [] scan)))

^{:line 1121 :file "/home/tom/code/north/src/north/main.bclj"} (defn- heal-project [^String threads-dir ^Probe p]
  ^{:line 1122 :file "/home/tom/code/north/src/north/main.bclj"} (let [files ^{:line 1122 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/list-md threads-dir)
   ids ^{:line 1123 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1123 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 1123 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te)) ^{:line 1123 :file "/home/tom/code/north/src/north/main.bclj"} (k/thread-ids-i ^{:line 1123 :file "/home/tom/code/north/src/north/main.bclj"} (:idx p)))
   scan ^{:line 1124 :file "/home/tom/code/north/src/north/main.bclj"} (scan-files threads-dir files ids)
   diff-ids ^{:line 1126 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1126 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 1126 :file "/home/tom/code/north/src/north/main.bclj"} (short-id te)) ^{:line 1126 :file "/home/tom/code/north/src/north/main.bclj"} (heal-targets p))
   targets ^{:line 1127 :file "/home/tom/code/north/src/north/main.bclj"} (distinct-ids ^{:line 1127 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1127 :file "/home/tom/code/north/src/north/main.bclj"} (concat diff-ids ^{:line 1127 :file "/home/tom/code/north/src/north/main.bclj"} (broken-head-ids scan ^{:line 1127 :file "/home/tom/code/north/src/north/main.bclj"} (:idx p)))))]
  ^{:line 1128 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1128 :file "/home/tom/code/north/src/north/main.bclj"} (empty? targets) ^{:line 1129 :file "/home/tom/code/north/src/north/main.bclj"} (println "heal: nothing to do — every thread file already matches the log.") ^{:line 1130 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1131 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [id targets]
  ^{:line 1132 :file "/home/tom/code/north/src/north/main.bclj"} (let [te ^{:line 1132 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" id)
   title ^{:line 1133 :file "/home/tom/code/north/src/north/main.bclj"} (let [t ^{:line 1133 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i ^{:line 1133 :file "/home/tom/code/north/src/north/main.bclj"} (:idx p) te "title")]
  ^{:line 1133 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1133 :file "/home/tom/code/north/src/north/main.bclj"} (some? t) t "untitled"))
   existing ^{:line 1134 :file "/home/tom/code/north/src/north/main.bclj"} (path-of scan id)
   path ^{:line 1135 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1135 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? existing) ^{:line 1136 :file "/home/tom/code/north/src/north/main.bclj"} (str threads-dir "/" id "-" ^{:line 1136 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/slugify title) ".md") existing)]
  ^{:line 1138 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/spit-file path ^{:line 1138 :file "/home/tom/code/north/src/north/main.bclj"} (exp/thread-md ^{:line 1138 :file "/home/tom/code/north/src/north/main.bclj"} (:log-facts p) te))
  ^{:line 1139 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1139 :file "/home/tom/code/north/src/north/main.bclj"} (str "  re-rendered " id "  " ^{:line 1139 :file "/home/tom/code/north/src/north/main.bclj"} (trunc title 52)))))
  ^{:line 1140 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1140 :file "/home/tom/code/north/src/north/main.bclj"} (str "heal: re-rendered " ^{:line 1140 :file "/home/tom/code/north/src/north/main.bclj"} (count targets) " thread file(s) from the log. Log untouched."))))))

^{:line 1143 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord AdoptResult [adopted skipped failed dropped])

(defn adoptresult-adopted [r] (:adopted r))

(defn adoptresult-skipped [r] (:skipped r))

(defn adoptresult-failed [r] (:failed r))

(defn adoptresult-dropped [r] (:dropped r))

^{:line 1149 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^Boolean adoptable? [c]
  ^{:line 1150 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1150 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1150 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? ^{:line 1150 :file "/home/tom/code/north/src/north/main.bclj"} (:p c))) ^{:line 1150 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1150 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? ^{:line 1150 :file "/home/tom/code/north/src/north/main.bclj"} (:r c)))))

^{:line 1161 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^AdoptResult adopt-hand-facts [port live hand]
  ^{:line 1162 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1163 :file "/home/tom/code/north/src/north/main.bclj"} (fn [acc c] ^{:line 1164 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 1165 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1165 :file "/home/tom/code/north/src/north/main.bclj"} (adoptable? c)) ^{:line 1166 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1167 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1167 :file "/home/tom/code/north/src/north/main.bclj"} (str "  drop (parse artifact) " ^{:line 1167 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 1167 :file "/home/tom/code/north/src/north/main.bclj"} (:l c)) "  pred=<" ^{:line 1167 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) "> val=<" ^{:line 1167 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 1167 :file "/home/tom/code/north/src/north/main.bclj"} (:r c) 40) ">"))
  ^{:line 1168 :file "/home/tom/code/north/src/north/main.bclj"} (->AdoptResult ^{:line 1168 :file "/home/tom/code/north/src/north/main.bclj"} (:adopted acc) ^{:line 1168 :file "/home/tom/code/north/src/north/main.bclj"} (:skipped acc) ^{:line 1168 :file "/home/tom/code/north/src/north/main.bclj"} (:failed acc) ^{:line 1168 :file "/home/tom/code/north/src/north/main.bclj"} (+ ^{:line 1168 :file "/home/tom/code/north/src/north/main.bclj"} (:dropped acc) 1)))
  ^{:line 1169 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1169 :file "/home/tom/code/north/src/north/main.bclj"} (k/single? ^{:line 1169 :file "/home/tom/code/north/src/north/main.bclj"} (:p c)) ^{:line 1170 :file "/home/tom/code/north/src/north/main.bclj"} (let [v ^{:line 1170 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i live ^{:line 1170 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) ^{:line 1170 :file "/home/tom/code/north/src/north/main.bclj"} (:p c))]
  ^{:line 1170 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1170 :file "/home/tom/code/north/src/north/main.bclj"} (some? v) ^{:line 1170 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1170 :file "/home/tom/code/north/src/north/main.bclj"} (= v ^{:line 1170 :file "/home/tom/code/north/src/north/main.bclj"} (:r c)))))) ^{:line 1171 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1172 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1172 :file "/home/tom/code/north/src/north/main.bclj"} (str "  skip (log won) " ^{:line 1172 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 1172 :file "/home/tom/code/north/src/north/main.bclj"} (:l c)) "  " ^{:line 1172 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) "  " ^{:line 1172 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 1172 :file "/home/tom/code/north/src/north/main.bclj"} (:r c) 56)))
  ^{:line 1173 :file "/home/tom/code/north/src/north/main.bclj"} (->AdoptResult ^{:line 1173 :file "/home/tom/code/north/src/north/main.bclj"} (:adopted acc) ^{:line 1173 :file "/home/tom/code/north/src/north/main.bclj"} (+ ^{:line 1173 :file "/home/tom/code/north/src/north/main.bclj"} (:skipped acc) 1) ^{:line 1173 :file "/home/tom/code/north/src/north/main.bclj"} (:failed acc) ^{:line 1173 :file "/home/tom/code/north/src/north/main.bclj"} (:dropped acc)))
  :else ^{:line 1175 :file "/home/tom/code/north/src/north/main.bclj"} (let [r ^{:line 1175 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port "assert" ^{:line 1175 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) ^{:line 1175 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) ^{:line 1175 :file "/home/tom/code/north/src/north/main.bclj"} (:r c) 5)]
  ^{:line 1176 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1176 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? r "ok:") ^{:line 1177 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1178 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1178 :file "/home/tom/code/north/src/north/main.bclj"} (str "  adopted " ^{:line 1178 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 1178 :file "/home/tom/code/north/src/north/main.bclj"} (:l c)) "  " ^{:line 1178 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) "  " ^{:line 1178 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 1178 :file "/home/tom/code/north/src/north/main.bclj"} (:r c) 56)))
  ^{:line 1179 :file "/home/tom/code/north/src/north/main.bclj"} (->AdoptResult ^{:line 1179 :file "/home/tom/code/north/src/north/main.bclj"} (+ ^{:line 1179 :file "/home/tom/code/north/src/north/main.bclj"} (:adopted acc) 1) ^{:line 1179 :file "/home/tom/code/north/src/north/main.bclj"} (:skipped acc) ^{:line 1179 :file "/home/tom/code/north/src/north/main.bclj"} (:failed acc) ^{:line 1179 :file "/home/tom/code/north/src/north/main.bclj"} (:dropped acc))) ^{:line 1180 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1181 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1181 :file "/home/tom/code/north/src/north/main.bclj"} (str "  FAILED  " ^{:line 1181 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 1181 :file "/home/tom/code/north/src/north/main.bclj"} (:l c)) "  " ^{:line 1181 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) "  -> " r))
  ^{:line 1182 :file "/home/tom/code/north/src/north/main.bclj"} (->AdoptResult ^{:line 1182 :file "/home/tom/code/north/src/north/main.bclj"} (:adopted acc) ^{:line 1182 :file "/home/tom/code/north/src/north/main.bclj"} (:skipped acc) ^{:line 1182 :file "/home/tom/code/north/src/north/main.bclj"} (+ ^{:line 1182 :file "/home/tom/code/north/src/north/main.bclj"} (:failed acc) 1) ^{:line 1182 :file "/home/tom/code/north/src/north/main.bclj"} (:dropped acc))))))) ^{:line 1183 :file "/home/tom/code/north/src/north/main.bclj"} (->AdoptResult 0 0 0 0) hand))

^{:line 1190 :file "/home/tom/code/north/src/north/main.bclj"} (defn- report-tombstoned [tombstoned]
  ^{:line 1191 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1191 :file "/home/tom/code/north/src/north/main.bclj"} (empty? tombstoned) nil ^{:line 1193 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1194 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1194 :file "/home/tom/code/north/src/north/main.bclj"} (str "retracted (stale projection) — skipped " ^{:line 1194 :file "/home/tom/code/north/src/north/main.bclj"} (count tombstoned) " fact(s) net-dead in the log (re-rendered away, NOT resurrected; --resurrect to force-adopt):"))
  ^{:line 1196 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [c tombstoned]
  ^{:line 1197 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1197 :file "/home/tom/code/north/src/north/main.bclj"} (str "    " ^{:line 1197 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 1197 :file "/home/tom/code/north/src/north/main.bclj"} (:l c)) "  " ^{:line 1197 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) "  " ^{:line 1197 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 1197 :file "/home/tom/code/north/src/north/main.bclj"} (:r c) 72)))))))

^{:line 1199 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-heal [^String threads-dir ^String log ^Boolean adopt ^Boolean resurrect]
  ^{:line 1200 :file "/home/tom/code/north/src/north/main.bclj"} (let [p ^{:line 1200 :file "/home/tom/code/north/src/north/main.bclj"} (probe threads-dir log)
   adopt-list ^{:line 1203 :file "/home/tom/code/north/src/north/main.bclj"} (if resurrect ^{:line 1203 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1203 :file "/home/tom/code/north/src/north/main.bclj"} (concat ^{:line 1203 :file "/home/tom/code/north/src/north/main.bclj"} (:hand p) ^{:line 1203 :file "/home/tom/code/north/src/north/main.bclj"} (:tombstoned p))) ^{:line 1203 :file "/home/tom/code/north/src/north/main.bclj"} (:hand p))
   has-hand ^{:line 1204 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1204 :file "/home/tom/code/north/src/north/main.bclj"} (empty? ^{:line 1204 :file "/home/tom/code/north/src/north/main.bclj"} (:hand p)))
   has-adoptable ^{:line 1205 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1205 :file "/home/tom/code/north/src/north/main.bclj"} (empty? adopt-list))]
  ^{:line 1206 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 1210 :file "/home/tom/code/north/src/north/main.bclj"} (and has-hand ^{:line 1210 :file "/home/tom/code/north/src/north/main.bclj"} (not adopt)) ^{:line 1211 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1212 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1212 :file "/home/tom/code/north/src/north/main.bclj"} (str "heal REFUSED — " ^{:line 1212 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1212 :file "/home/tom/code/north/src/north/main.bclj"} (:hand p)) " genuinely-new file fact(s) not in the log " "(hand edits). A human decides: adopt via `heal --adopt` (or `tell`/bulk `import`). " "Nothing was touched:"))
  ^{:line 1215 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [c ^{:line 1215 :file "/home/tom/code/north/src/north/main.bclj"} (:hand p)]
  ^{:line 1216 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1216 :file "/home/tom/code/north/src/north/main.bclj"} (str "    " ^{:line 1216 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 1216 :file "/home/tom/code/north/src/north/main.bclj"} (:l c)) "  " ^{:line 1216 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) "  " ^{:line 1216 :file "/home/tom/code/north/src/north/main.bclj"} (trunc ^{:line 1216 :file "/home/tom/code/north/src/north/main.bclj"} (:r c) 72))))
  ^{:line 1217 :file "/home/tom/code/north/src/north/main.bclj"} (report-tombstoned ^{:line 1217 :file "/home/tom/code/north/src/north/main.bclj"} (:tombstoned p)))
  :else ^{:line 1219 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1219 :file "/home/tom/code/north/src/north/main.bclj"} (and adopt has-adoptable) ^{:line 1223 :file "/home/tom/code/north/src/north/main.bclj"} (let [port ^{:line 1223 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-port)]
  ^{:line 1224 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1224 :file "/home/tom/code/north/src/north/main.bclj"} (< ^{:line 1224 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-version port) 0) ^{:line 1225 :file "/home/tom/code/north/src/north/main.bclj"} (println "no coordinator on 127.0.0.1:7977 — adopt needs the daemon to serialize writes. Run `north up`.") ^{:line 1226 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1227 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1227 :file "/home/tom/code/north/src/north/main.bclj"} (not resurrect) ^{:line 1227 :file "/home/tom/code/north/src/north/main.bclj"} (report-tombstoned ^{:line 1227 :file "/home/tom/code/north/src/north/main.bclj"} (:tombstoned p)) nil)
  ^{:line 1228 :file "/home/tom/code/north/src/north/main.bclj"} (let [res ^{:line 1228 :file "/home/tom/code/north/src/north/main.bclj"} (adopt-hand-facts port ^{:line 1228 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log) adopt-list)]
  ^{:line 1229 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1229 :file "/home/tom/code/north/src/north/main.bclj"} (str "heal --adopt: " ^{:line 1229 :file "/home/tom/code/north/src/north/main.bclj"} (:adopted res) " adopted, " ^{:line 1229 :file "/home/tom/code/north/src/north/main.bclj"} (:skipped res) " skipped (log won), " ^{:line 1230 :file "/home/tom/code/north/src/north/main.bclj"} (:dropped res) " dropped (parse artifact), " ^{:line 1231 :file "/home/tom/code/north/src/north/main.bclj"} (:failed res) " failed via coordinator."))
  ^{:line 1232 :file "/home/tom/code/north/src/north/main.bclj"} (heal-project threads-dir ^{:line 1232 :file "/home/tom/code/north/src/north/main.bclj"} (probe threads-dir log)))))) ^{:line 1233 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1234 :file "/home/tom/code/north/src/north/main.bclj"} (report-tombstoned ^{:line 1234 :file "/home/tom/code/north/src/north/main.bclj"} (:tombstoned p))
  ^{:line 1235 :file "/home/tom/code/north/src/north/main.bclj"} (heal-project threads-dir p))))))

^{:line 1238 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord EntryPoint [te note created])

(defn entrypoint-te [r] (:te r))

(defn entrypoint-note [r] (:note r))

(defn entrypoint-created [r] (:created r))

^{:line 1241 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String entry-note [idx ^String te]
  ^{:line 1242 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1242 :file "/home/tom/code/north/src/north/main.bclj"} (fn [acc v] ^{:line 1243 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1243 :file "/home/tom/code/north/src/north/main.bclj"} (and ^{:line 1243 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? acc) ^{:line 1243 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? v "SESSION ENTRY POINT")) v acc)) "" ^{:line 1244 :file "/home/tom/code/north/src/north/main.bclj"} (k/many-i idx te "note")))

^{:line 1247 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^EntryPoint find-entry [idx]
  ^{:line 1248 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1248 :file "/home/tom/code/north/src/north/main.bclj"} (fn [best te] ^{:line 1249 :file "/home/tom/code/north/src/north/main.bclj"} (let [note ^{:line 1249 :file "/home/tom/code/north/src/north/main.bclj"} (entry-note idx te)]
  ^{:line 1250 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1250 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? note) best ^{:line 1252 :file "/home/tom/code/north/src/north/main.bclj"} (let [c ^{:line 1252 :file "/home/tom/code/north/src/north/main.bclj"} (let [cc ^{:line 1252 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx te "created_at")]
  ^{:line 1252 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1252 :file "/home/tom/code/north/src/north/main.bclj"} (some? cc) cc ""))]
  ^{:line 1253 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1253 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 1253 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? ^{:line 1253 :file "/home/tom/code/north/src/north/main.bclj"} (:te best)) ^{:line 1253 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/str-lt? ^{:line 1253 :file "/home/tom/code/north/src/north/main.bclj"} (:created best) c)) ^{:line 1254 :file "/home/tom/code/north/src/north/main.bclj"} (->EntryPoint te note c) best))))) ^{:line 1256 :file "/home/tom/code/north/src/north/main.bclj"} (->EntryPoint "" "" "") ^{:line 1257 :file "/home/tom/code/north/src/north/main.bclj"} (k/thread-ids-i idx)))

^{:line 1259 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-boot [^String threads-dir ^String log]
  ^{:line 1260 :file "/home/tom/code/north/src/north/main.bclj"} (let [p ^{:line 1260 :file "/home/tom/code/north/src/north/main.bclj"} (probe threads-dir log)
   idx ^{:line 1261 :file "/home/tom/code/north/src/north/main.bclj"} (:idx p)
   today ^{:line 1262 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/today-iso)
   before? fram.rt/str-lt?]
  ^{:line 1265 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1265 :file "/home/tom/code/north/src/north/main.bclj"} (str "=> " ^{:line 1265 :file "/home/tom/code/north/src/north/main.bclj"} (safety-line p)))
  ^{:line 1266 :file "/home/tom/code/north/src/north/main.bclj"} (let [h ^{:line 1266 :file "/home/tom/code/north/src/north/main.bclj"} (hygiene-line p)]
  ^{:line 1266 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1266 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1266 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? h)) ^{:line 1266 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1266 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1266 :file "/home/tom/code/north/src/north/main.bclj"} (str "   " h)))))
  ^{:line 1268 :file "/home/tom/code/north/src/north/main.bclj"} (let [e ^{:line 1268 :file "/home/tom/code/north/src/north/main.bclj"} (find-entry idx)]
  ^{:line 1269 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1269 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? ^{:line 1269 :file "/home/tom/code/north/src/north/main.bclj"} (:te e)) ^{:line 1270 :file "/home/tom/code/north/src/north/main.bclj"} (println "\nENTRY POINT — none (no thread carries a `SESSION ENTRY POINT` note)") ^{:line 1271 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1272 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1272 :file "/home/tom/code/north/src/north/main.bclj"} (str "\nENTRY POINT — " ^{:line 1272 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 1272 :file "/home/tom/code/north/src/north/main.bclj"} (:te e)) "  " ^{:line 1272 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 1272 :file "/home/tom/code/north/src/north/main.bclj"} (:te e))))
  ^{:line 1273 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1273 :file "/home/tom/code/north/src/north/main.bclj"} (:note e))
  ^{:line 1274 :file "/home/tom/code/north/src/north/main.bclj"} (let [ls ^{:line 1274 :file "/home/tom/code/north/src/north/main.bclj"} (k/many-i idx ^{:line 1274 :file "/home/tom/code/north/src/north/main.bclj"} (:te e) "learning")]
  ^{:line 1275 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1275 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1275 :file "/home/tom/code/north/src/north/main.bclj"} (empty? ls)) ^{:line 1275 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1276 :file "/home/tom/code/north/src/north/main.bclj"} (println "\nSTANDING MANDATES (learning):")
  ^{:line 1277 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [l ls]
  ^{:line 1277 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1277 :file "/home/tom/code/north/src/north/main.bclj"} (str "  - " l)))))))))
  ^{:line 1279 :file "/home/tom/code/north/src/north/main.bclj"} (let [nonterm ^{:line 1279 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1279 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 1279 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1279 :file "/home/tom/code/north/src/north/main.bclj"} (proj/terminal-i? idx te))) ^{:line 1280 :file "/home/tom/code/north/src/north/main.bclj"} (proj/work-thread-ids-i idx))]
  ^{:line 1281 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1281 :file "/home/tom/code/north/src/north/main.bclj"} (str "\nBOARD — active " ^{:line 1281 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1281 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx nonterm today before? "active")) "  ready " ^{:line 1282 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1282 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx nonterm today before? "ready")) "  blocked " ^{:line 1283 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1283 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx nonterm today before? "blocked")) "  draft " ^{:line 1284 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1284 :file "/home/tom/code/north/src/north/main.bclj"} (in-condition idx nonterm today before? "draft"))))
  ^{:line 1286 :file "/home/tom/code/north/src/north/main.bclj"} (let [cands ^{:line 1286 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1286 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 1286 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1286 :file "/home/tom/code/north/src/north/main.bclj"} (proj/terminal-i? idx te))) nonterm)
   items ^{:line 1287 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1287 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 1287 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 1287 :file "/home/tom/code/north/src/north/main.bclj"} (:score it) 0)) ^{:line 1288 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1288 :file "/home/tom/code/north/src/north/main.bclj"} (fn [te] ^{:line 1289 :file "/home/tom/code/north/src/north/main.bclj"} (->LevItem te ^{:line 1289 :file "/home/tom/code/north/src/north/main.bclj"} (proj/leverage-score idx te))) cands))
   ranked ^{:line 1291 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1291 :file "/home/tom/code/north/src/north/main.bclj"} (take 5 ^{:line 1291 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 1291 :file "/home/tom/code/north/src/north/main.bclj"} (fn [it] ^{:line 1291 :file "/home/tom/code/north/src/north/main.bclj"} (- 0 ^{:line 1291 :file "/home/tom/code/north/src/north/main.bclj"} (:score it))) items)))]
  ^{:line 1292 :file "/home/tom/code/north/src/north/main.bclj"} (println "TOP LEVERAGE — finishing these transitively frees the most stuck threads")
  ^{:line 1293 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [it ranked]
  ^{:line 1294 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1294 :file "/home/tom/code/north/src/north/main.bclj"} (str "  unblocks " ^{:line 1294 :file "/home/tom/code/north/src/north/main.bclj"} (:score it) "  " ^{:line 1294 :file "/home/tom/code/north/src/north/main.bclj"} (short-id ^{:line 1294 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)) "  " ^{:line 1294 :file "/home/tom/code/north/src/north/main.bclj"} (title-of idx ^{:line 1294 :file "/home/tom/code/north/src/north/main.bclj"} (:te it)))))))))

^{:line 1313 :file "/home/tom/code/north/src/north/main.bclj"} (defn- split-ws [^String s]
  ^{:line 1314 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1314 :file "/home/tom/code/north/src/north/main.bclj"} (fn [w] ^{:line 1314 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1314 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? w))) ^{:line 1314 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1314 :file "/home/tom/code/north/src/north/main.bclj"} (str/split s #"\s+"))))

^{:line 1316 :file "/home/tom/code/north/src/north/main.bclj"} (defn- single-valued-preds []
  ^{:line 1317 :file "/home/tom/code/north/src/north/main.bclj"} (split-ws ^{:line 1317 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/getenv-or "FRAM_SINGLE_VALUED" "")))

^{:line 1320 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^Boolean all-ref? [facts ^String pred]
  ^{:line 1321 :file "/home/tom/code/north/src/north/main.bclj"} (loop [cs facts
   seen false]
  ^{:line 1322 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1322 :file "/home/tom/code/north/src/north/main.bclj"} (empty? cs) seen ^{:line 1324 :file "/home/tom/code/north/src/north/main.bclj"} (let [c ^{:line 1324 :file "/home/tom/code/north/src/north/main.bclj"} (first cs)]
  ^{:line 1325 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1325 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 1325 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) pred) ^{:line 1326 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1326 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? ^{:line 1326 :file "/home/tom/code/north/src/north/main.bclj"} (:r c) "@") ^{:line 1327 :file "/home/tom/code/north/src/north/main.bclj"} (recur ^{:line 1327 :file "/home/tom/code/north/src/north/main.bclj"} (rest cs) true) false) ^{:line 1329 :file "/home/tom/code/north/src/north/main.bclj"} (recur ^{:line 1329 :file "/home/tom/code/north/src/north/main.bclj"} (rest cs) seen))))))

^{:line 1331 :file "/home/tom/code/north/src/north/main.bclj"} (defn- distinct-preds [facts]
  ^{:line 1332 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1332 :file "/home/tom/code/north/src/north/main.bclj"} (fn [acc c] ^{:line 1333 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1333 :file "/home/tom/code/north/src/north/main.bclj"} (k/vec-contains? acc ^{:line 1333 :file "/home/tom/code/north/src/north/main.bclj"} (:p c)) acc ^{:line 1333 :file "/home/tom/code/north/src/north/main.bclj"} (conj acc ^{:line 1333 :file "/home/tom/code/north/src/north/main.bclj"} (:p c)))) ^{:line 1334 :file "/home/tom/code/north/src/north/main.bclj"} [] facts))

^{:line 1336 :file "/home/tom/code/north/src/north/main.bclj"} (defn- seed-facts [^String log]
  ^{:line 1337 :file "/home/tom/code/north/src/north/main.bclj"} (let [facts ^{:line 1337 :file "/home/tom/code/north/src/north/main.bclj"} (live-facts log)
   card ^{:line 1338 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1338 :file "/home/tom/code/north/src/north/main.bclj"} (fn [p] ^{:line 1338 :file "/home/tom/code/north/src/north/main.bclj"} (k/->Fact ^{:line 1338 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" p) "cardinality" "single")) ^{:line 1339 :file "/home/tom/code/north/src/north/main.bclj"} (single-valued-preds))
   acyc ^{:line 1340 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1340 :file "/home/tom/code/north/src/north/main.bclj"} (fn [p] ^{:line 1340 :file "/home/tom/code/north/src/north/main.bclj"} (k/->Fact ^{:line 1340 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" p) "acyclic" "true")) ^{:line 1341 :file "/home/tom/code/north/src/north/main.bclj"} ["depends_on" "part_of"])
   refs ^{:line 1342 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1342 :file "/home/tom/code/north/src/north/main.bclj"} (fn [p] ^{:line 1342 :file "/home/tom/code/north/src/north/main.bclj"} (all-ref? facts p)) ^{:line 1342 :file "/home/tom/code/north/src/north/main.bclj"} (distinct-preds facts))
   vk ^{:line 1343 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1343 :file "/home/tom/code/north/src/north/main.bclj"} (fn [p] ^{:line 1343 :file "/home/tom/code/north/src/north/main.bclj"} (k/->Fact ^{:line 1343 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" p) "value_kind" "ref")) refs)]
  ^{:line 1344 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1344 :file "/home/tom/code/north/src/north/main.bclj"} (concat card acyc vk))))

^{:line 1346 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-schema-seed [^String log ^Boolean execute]
  ^{:line 1347 :file "/home/tom/code/north/src/north/main.bclj"} (let [seeds ^{:line 1347 :file "/home/tom/code/north/src/north/main.bclj"} (seed-facts log)]
  ^{:line 1348 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1348 :file "/home/tom/code/north/src/north/main.bclj"} (not execute) ^{:line 1349 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1350 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1350 :file "/home/tom/code/north/src/north/main.bclj"} (str "schema-seed DRY-RUN — " ^{:line 1350 :file "/home/tom/code/north/src/north/main.bclj"} (count seeds) " fact(s); nothing written."))
  ^{:line 1351 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [c seeds]
  ^{:line 1351 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1351 :file "/home/tom/code/north/src/north/main.bclj"} (str "  tell " ^{:line 1351 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) " " ^{:line 1351 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) " " ^{:line 1351 :file "/home/tom/code/north/src/north/main.bclj"} (:r c))))
  ^{:line 1352 :file "/home/tom/code/north/src/north/main.bclj"} (println "Run `north schema-seed --execute` (coordinator session) to write.")) ^{:line 1353 :file "/home/tom/code/north/src/north/main.bclj"} (let [idx ^{:line 1353 :file "/home/tom/code/north/src/north/main.bclj"} (live-idx log)
   subs ^{:line 1354 :file "/home/tom/code/north/src/north/main.bclj"} (distinct-ids ^{:line 1354 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1354 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 1354 :file "/home/tom/code/north/src/north/main.bclj"} (:l c)) seeds))
   collisions ^{:line 1355 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1355 :file "/home/tom/code/north/src/north/main.bclj"} (fn [s] ^{:line 1355 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 1355 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx s "title"))) subs)]
  ^{:line 1356 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1356 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1356 :file "/home/tom/code/north/src/north/main.bclj"} (empty? collisions)) ^{:line 1357 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1358 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1358 :file "/home/tom/code/north/src/north/main.bclj"} (str "!!! schema-seed ABORTED — " ^{:line 1358 :file "/home/tom/code/north/src/north/main.bclj"} (count collisions) " predicate name(s) collide with a live thread id."))
  ^{:line 1360 :file "/home/tom/code/north/src/north/main.bclj"} (println "    Writing predicate metadata onto these would pollute real threads:")
  ^{:line 1361 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [s collisions]
  ^{:line 1361 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1361 :file "/home/tom/code/north/src/north/main.bclj"} (str "      " s "  (has a `title` fact — is a thread)")))
  ^{:line 1362 :file "/home/tom/code/north/src/north/main.bclj"} (println "    No facts written. Rename the colliding thread(s) or exclude the pred(s).")) ^{:line 1363 :file "/home/tom/code/north/src/north/main.bclj"} (let [port ^{:line 1363 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-port)]
  ^{:line 1364 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1364 :file "/home/tom/code/north/src/north/main.bclj"} (< ^{:line 1364 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/coord-version port) 0) ^{:line 1365 :file "/home/tom/code/north/src/north/main.bclj"} (println "no coordinator on 127.0.0.1:7977 — writes won't serialize. Run `north up`.") ^{:line 1366 :file "/home/tom/code/north/src/north/main.bclj"} (let [results ^{:line 1366 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1366 :file "/home/tom/code/north/src/north/main.bclj"} (fn [c] ^{:line 1367 :file "/home/tom/code/north/src/north/main.bclj"} (tell-retry port "assert" ^{:line 1367 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) ^{:line 1367 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) ^{:line 1367 :file "/home/tom/code/north/src/north/main.bclj"} (:r c) 5)) seeds)
   oks ^{:line 1369 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1369 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1369 :file "/home/tom/code/north/src/north/main.bclj"} (fn [r] ^{:line 1369 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? r "ok:")) results))]
  ^{:line 1370 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1370 :file "/home/tom/code/north/src/north/main.bclj"} (str "schema-seed EXECUTED — " oks "/" ^{:line 1370 :file "/home/tom/code/north/src/north/main.bclj"} (count seeds) " fact(s) committed via coordinator."))))))))))

^{:line 1377 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-tools []
  ^{:line 1378 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1379 :file "/home/tom/code/north/src/north/main.bclj"} (println "NORTH — curated tool surface (the MCP verbs; bin/north-mcp is authoritative):")
  ^{:line 1380 :file "/home/tom/code/north/src/north/main.bclj"} (println "  work queue : ready · next · board · blocked · agenda · leverage · needs-review")
  ^{:line 1381 :file "/home/tom/code/north/src/north/main.bclj"} (println "  vocabulary : schema (census by kind) · schema-seed (declare predicate metadata)")
  ^{:line 1382 :file "/home/tom/code/north/src/north/main.bclj"} (println "  read/write : show · capture · tell · retract · validate   (untell = legacy alias of retract)")
  ^{:line 1383 :file "/home/tom/code/north/src/north/main.bclj"} (println "  time       : clock start|stop|status|report")
  ^{:line 1384 :file "/home/tom/code/north/src/north/main.bclj"} (println "  agents     : dispatch · spawn")
  ^{:line 1385 :file "/home/tom/code/north/src/north/main.bclj"} (println "  view       : presentation")
  ^{:line 1386 :file "/home/tom/code/north/src/north/main.bclj"} (println "")
  ^{:line 1387 :file "/home/tom/code/north/src/north/main.bclj"} (println "Engine core underneath: fram = 10 tools (tell/retract/show/ask/validate + 5 graph-edit verbs).")
  ^{:line 1388 :file "/home/tom/code/north/src/north/main.bclj"} (println "Vocabulary is DATA, not tools: `north show <pred>` reveals a predicate's metadata")
  ^{:line 1389 :file "/home/tom/code/north/src/north/main.bclj"} (println "(cardinality/value_kind/acyclic facts). Seed that metadata with `north schema-seed`.")))

^{:line 1397 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord PredCount [pred n])

(defn predcount-pred [r] (:pred r))

(defn predcount-n [r] (:n r))

^{:line 1398 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord KindStat [kind subjects facts preds])

(defn kindstat-kind [r] (:kind r))

(defn kindstat-subjects [r] (:subjects r))

(defn kindstat-facts [r] (:facts r))

(defn kindstat-preds [r] (:preds r))

^{:line 1401 :file "/home/tom/code/north/src/north/main.bclj"} (def ^String KP-SEP "\u0001")

^{:line 1403 :file "/home/tom/code/north/src/north/main.bclj"} (defn- census [idx facts]
  ^{:line 1404 :file "/home/tom/code/north/src/north/main.bclj"} (let [subj-list ^{:line 1404 :file "/home/tom/code/north/src/north/main.bclj"} (:subjects idx)
   skind ^{:line 1406 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1406 :file "/home/tom/code/north/src/north/main.bclj"} (fn [m s] ^{:line 1407 :file "/home/tom/code/north/src/north/main.bclj"} (assoc m s ^{:line 1407 :file "/home/tom/code/north/src/north/main.bclj"} (kind-of idx s))) ^{:line 1408 :file "/home/tom/code/north/src/north/main.bclj"} {} subj-list)
   ksub ^{:line 1410 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1410 :file "/home/tom/code/north/src/north/main.bclj"} (fn [m s] ^{:line 1411 :file "/home/tom/code/north/src/north/main.bclj"} (let [kd ^{:line 1411 :file "/home/tom/code/north/src/north/main.bclj"} (get skind s "other")]
  ^{:line 1412 :file "/home/tom/code/north/src/north/main.bclj"} (assoc m kd ^{:line 1412 :file "/home/tom/code/north/src/north/main.bclj"} (+ 1 ^{:line 1412 :file "/home/tom/code/north/src/north/main.bclj"} (get m kd 0))))) ^{:line 1413 :file "/home/tom/code/north/src/north/main.bclj"} {} subj-list)
   kfacts ^{:line 1415 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1415 :file "/home/tom/code/north/src/north/main.bclj"} (fn [m c] ^{:line 1416 :file "/home/tom/code/north/src/north/main.bclj"} (let [kd ^{:line 1416 :file "/home/tom/code/north/src/north/main.bclj"} (get skind ^{:line 1416 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) "other")]
  ^{:line 1417 :file "/home/tom/code/north/src/north/main.bclj"} (assoc m kd ^{:line 1417 :file "/home/tom/code/north/src/north/main.bclj"} (+ 1 ^{:line 1417 :file "/home/tom/code/north/src/north/main.bclj"} (get m kd 0))))) ^{:line 1418 :file "/home/tom/code/north/src/north/main.bclj"} {} facts)
   kpreds ^{:line 1420 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1420 :file "/home/tom/code/north/src/north/main.bclj"} (fn [m c] ^{:line 1421 :file "/home/tom/code/north/src/north/main.bclj"} (let [kd ^{:line 1421 :file "/home/tom/code/north/src/north/main.bclj"} (get skind ^{:line 1421 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) "other")
   kk ^{:line 1422 :file "/home/tom/code/north/src/north/main.bclj"} (str kd KP-SEP ^{:line 1422 :file "/home/tom/code/north/src/north/main.bclj"} (:p c))]
  ^{:line 1423 :file "/home/tom/code/north/src/north/main.bclj"} (assoc m kk ^{:line 1423 :file "/home/tom/code/north/src/north/main.bclj"} (+ 1 ^{:line 1423 :file "/home/tom/code/north/src/north/main.bclj"} (get m kk 0))))) ^{:line 1424 :file "/home/tom/code/north/src/north/main.bclj"} {} facts)
   kp-keys ^{:line 1425 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1425 :file "/home/tom/code/north/src/north/main.bclj"} (keys kpreds))
   stats ^{:line 1426 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1426 :file "/home/tom/code/north/src/north/main.bclj"} (fn [kd] ^{:line 1427 :file "/home/tom/code/north/src/north/main.bclj"} (let [pfx ^{:line 1427 :file "/home/tom/code/north/src/north/main.bclj"} (str kd KP-SEP)
   off ^{:line 1428 :file "/home/tom/code/north/src/north/main.bclj"} (+ ^{:line 1428 :file "/home/tom/code/north/src/north/main.bclj"} (count kd) 1)
   plist ^{:line 1429 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1429 :file "/home/tom/code/north/src/north/main.bclj"} (fn [kk] ^{:line 1430 :file "/home/tom/code/north/src/north/main.bclj"} (->PredCount ^{:line 1430 :file "/home/tom/code/north/src/north/main.bclj"} (subs kk off) ^{:line 1430 :file "/home/tom/code/north/src/north/main.bclj"} (get kpreds kk 0))) ^{:line 1431 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1431 :file "/home/tom/code/north/src/north/main.bclj"} (fn [kk] ^{:line 1431 :file "/home/tom/code/north/src/north/main.bclj"} (str/starts-with? kk pfx)) kp-keys))
   ptop ^{:line 1432 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1432 :file "/home/tom/code/north/src/north/main.bclj"} (take 8 ^{:line 1432 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 1432 :file "/home/tom/code/north/src/north/main.bclj"} (fn [pc] ^{:line 1432 :file "/home/tom/code/north/src/north/main.bclj"} (- 0 ^{:line 1432 :file "/home/tom/code/north/src/north/main.bclj"} (:n pc))) plist)))]
  ^{:line 1433 :file "/home/tom/code/north/src/north/main.bclj"} (->KindStat kd ^{:line 1433 :file "/home/tom/code/north/src/north/main.bclj"} (get ksub kd 0) ^{:line 1433 :file "/home/tom/code/north/src/north/main.bclj"} (get kfacts kd 0) ptop))) ^{:line 1434 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1434 :file "/home/tom/code/north/src/north/main.bclj"} (keys ksub)))]
  ^{:line 1435 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1435 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 1435 :file "/home/tom/code/north/src/north/main.bclj"} (fn [ks] ^{:line 1435 :file "/home/tom/code/north/src/north/main.bclj"} (- 0 ^{:line 1435 :file "/home/tom/code/north/src/north/main.bclj"} (:facts ks))) stats))))

^{:line 1445 :file "/home/tom/code/north/src/north/main.bclj"} (def ^String SP24 "                        ")

^{:line 1446 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String padr [^String s n]
  ^{:line 1447 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1447 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1447 :file "/home/tom/code/north/src/north/main.bclj"} (count s) n) s ^{:line 1447 :file "/home/tom/code/north/src/north/main.bclj"} (str s ^{:line 1447 :file "/home/tom/code/north/src/north/main.bclj"} (subs SP24 0 ^{:line 1447 :file "/home/tom/code/north/src/north/main.bclj"} (- n ^{:line 1447 :file "/home/tom/code/north/src/north/main.bclj"} (count s))))))

^{:line 1448 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String pad7 [n]
  ^{:line 1449 :file "/home/tom/code/north/src/north/main.bclj"} (let [s ^{:line 1449 :file "/home/tom/code/north/src/north/main.bclj"} (str n)]
  ^{:line 1449 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1449 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1449 :file "/home/tom/code/north/src/north/main.bclj"} (count s) 7) s ^{:line 1449 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 1449 :file "/home/tom/code/north/src/north/main.bclj"} (subs "0000000" 0 ^{:line 1449 :file "/home/tom/code/north/src/north/main.bclj"} (- 7 ^{:line 1449 :file "/home/tom/code/north/src/north/main.bclj"} (count s))) s))))

^{:line 1451 :file "/home/tom/code/north/src/north/main.bclj"} (defn- kind-subjects [idx ^String kind]
  ^{:line 1452 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1452 :file "/home/tom/code/north/src/north/main.bclj"} (fn [s] ^{:line 1452 :file "/home/tom/code/north/src/north/main.bclj"} (= ^{:line 1452 :file "/home/tom/code/north/src/north/main.bclj"} (kind-of idx s) kind)) ^{:line 1452 :file "/home/tom/code/north/src/north/main.bclj"} (:subjects idx)))

^{:line 1455 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord CovAcc [seen pc])

(defn covacc-seen [r] (:seen r))

(defn covacc-pc [r] (:pc r))

^{:line 1456 :file "/home/tom/code/north/src/north/main.bclj"} (defn- coverage [facts subjset]
  ^{:line 1457 :file "/home/tom/code/north/src/north/main.bclj"} (:pc ^{:line 1457 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1457 :file "/home/tom/code/north/src/north/main.bclj"} (fn [a c] ^{:line 1458 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1458 :file "/home/tom/code/north/src/north/main.bclj"} (get subjset ^{:line 1458 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) false) ^{:line 1459 :file "/home/tom/code/north/src/north/main.bclj"} (let [sk ^{:line 1459 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 1459 :file "/home/tom/code/north/src/north/main.bclj"} (:l c) KP-SEP ^{:line 1459 :file "/home/tom/code/north/src/north/main.bclj"} (:p c))]
  ^{:line 1460 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1460 :file "/home/tom/code/north/src/north/main.bclj"} (get ^{:line 1460 :file "/home/tom/code/north/src/north/main.bclj"} (:seen a) sk false) a ^{:line 1462 :file "/home/tom/code/north/src/north/main.bclj"} (->CovAcc ^{:line 1462 :file "/home/tom/code/north/src/north/main.bclj"} (assoc ^{:line 1462 :file "/home/tom/code/north/src/north/main.bclj"} (:seen a) sk true) ^{:line 1463 :file "/home/tom/code/north/src/north/main.bclj"} (assoc ^{:line 1463 :file "/home/tom/code/north/src/north/main.bclj"} (:pc a) ^{:line 1463 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) ^{:line 1463 :file "/home/tom/code/north/src/north/main.bclj"} (+ 1 ^{:line 1463 :file "/home/tom/code/north/src/north/main.bclj"} (get ^{:line 1463 :file "/home/tom/code/north/src/north/main.bclj"} (:pc a) ^{:line 1463 :file "/home/tom/code/north/src/north/main.bclj"} (:p c) 0)))))) a)) ^{:line 1465 :file "/home/tom/code/north/src/north/main.bclj"} (->CovAcc ^{:line 1465 :file "/home/tom/code/north/src/north/main.bclj"} {} ^{:line 1465 :file "/home/tom/code/north/src/north/main.bclj"} {}) facts)))

^{:line 1467 :file "/home/tom/code/north/src/north/main.bclj"} (defrecord FieldStat [pred subs pct required])

(defn fieldstat-pred [r] (:pred r))

(defn fieldstat-subs [r] (:subs r))

(defn fieldstat-pct [r] (:pct r))

(defn fieldstat-required [r] (:required r))

^{:line 1468 :file "/home/tom/code/north/src/north/main.bclj"} (defn- schema-fields [idx facts ^String kind]
  ^{:line 1469 :file "/home/tom/code/north/src/north/main.bclj"} (let [ksubs ^{:line 1469 :file "/home/tom/code/north/src/north/main.bclj"} (kind-subjects idx kind)
   total ^{:line 1470 :file "/home/tom/code/north/src/north/main.bclj"} (count ksubs)
   subjset ^{:line 1471 :file "/home/tom/code/north/src/north/main.bclj"} (reduce ^{:line 1471 :file "/home/tom/code/north/src/north/main.bclj"} (fn [m s] ^{:line 1472 :file "/home/tom/code/north/src/north/main.bclj"} (assoc m s true)) ^{:line 1472 :file "/home/tom/code/north/src/north/main.bclj"} {} ksubs)
   pc ^{:line 1473 :file "/home/tom/code/north/src/north/main.bclj"} (coverage facts subjset)
   stats ^{:line 1474 :file "/home/tom/code/north/src/north/main.bclj"} (mapv ^{:line 1474 :file "/home/tom/code/north/src/north/main.bclj"} (fn [p] ^{:line 1475 :file "/home/tom/code/north/src/north/main.bclj"} (let [n ^{:line 1475 :file "/home/tom/code/north/src/north/main.bclj"} (get pc p 0)
   pct ^{:line 1476 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1476 :file "/home/tom/code/north/src/north/main.bclj"} (> total 0) ^{:line 1476 :file "/home/tom/code/north/src/north/main.bclj"} (quot ^{:line 1476 :file "/home/tom/code/north/src/north/main.bclj"} (* 100 n) total) 0)
   req ^{:line 1478 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1478 :file "/home/tom/code/north/src/north/main.bclj"} (> total 0) ^{:line 1478 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1478 :file "/home/tom/code/north/src/north/main.bclj"} (* n 100) ^{:line 1478 :file "/home/tom/code/north/src/north/main.bclj"} (* total 98)) false)]
  ^{:line 1479 :file "/home/tom/code/north/src/north/main.bclj"} (->FieldStat p n pct req))) ^{:line 1480 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1480 :file "/home/tom/code/north/src/north/main.bclj"} (keys pc)))]
  ^{:line 1482 :file "/home/tom/code/north/src/north/main.bclj"} (vec ^{:line 1482 :file "/home/tom/code/north/src/north/main.bclj"} (sort-by ^{:line 1482 :file "/home/tom/code/north/src/north/main.bclj"} (fn [fs] ^{:line 1483 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 1483 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1483 :file "/home/tom/code/north/src/north/main.bclj"} (:required fs) "0" "1") "|" ^{:line 1484 :file "/home/tom/code/north/src/north/main.bclj"} (pad7 ^{:line 1484 :file "/home/tom/code/north/src/north/main.bclj"} (- 9999999 ^{:line 1484 :file "/home/tom/code/north/src/north/main.bclj"} (:subs fs))) "|" ^{:line 1484 :file "/home/tom/code/north/src/north/main.bclj"} (:pred fs))) stats))))

^{:line 1489 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String pred-ann [idx ^String p]
  ^{:line 1490 :file "/home/tom/code/north/src/north/main.bclj"} (let [ps ^{:line 1490 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1490 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 1490 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 1490 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx ^{:line 1490 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" p) "cardinality")) ^{:line 1491 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 1491 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx ^{:line 1491 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" p) "value_kind"))) ^{:line 1492 :file "/home/tom/code/north/src/north/main.bclj"} (str "@" p) p)
   card ^{:line 1493 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx ps "cardinality")
   vk ^{:line 1494 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx ps "value_kind")]
  ^{:line 1495 :file "/home/tom/code/north/src/north/main.bclj"} (str ^{:line 1495 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1495 :file "/home/tom/code/north/src/north/main.bclj"} (some? card) ^{:line 1495 :file "/home/tom/code/north/src/north/main.bclj"} (str "  cardinality=" card) "") ^{:line 1496 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1496 :file "/home/tom/code/north/src/north/main.bclj"} (some? vk) ^{:line 1496 :file "/home/tom/code/north/src/north/main.bclj"} (str " value_kind=" vk) ""))))

^{:line 1500 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^String kind-writer [^String kind]
  ^{:line 1501 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 1502 :file "/home/tom/code/north/src/north/main.bclj"} (= kind "thread") "north capture -> src/north/main.bclj capture-facts (title, kind=thread, created_at, committed, …)"
  ^{:line 1503 :file "/home/tom/code/north/src/north/main.bclj"} (= kind "concern") "concern declare -> cli/concern-cli.clj (put! kind=concern, intent, touches, reached)"
  ^{:line 1504 :file "/home/tom/code/north/src/north/main.bclj"} (= kind "agent") "agent identity -> sdk/src/identity.ts writeIdentity + bin/north-on-spawn (tell agent:<id> kind/role/display_name)"
  ^{:line 1505 :file "/home/tom/code/north/src/north/main.bclj"} (= kind "session-telemetry") "run/session telemetry -> sdk/src/telemetry.ts recordRun (kind=run) + bin/north-on-spawn (kind=session) + cli/presence-cli.clj (session leases)"
  ^{:line 1506 :file "/home/tom/code/north/src/north/main.bclj"} (= kind "msg") "mail + commands -> cli/msg-cli.clj (@msg: mail, @cmd: commands)"
  ^{:line 1507 :file "/home/tom/code/north/src/north/main.bclj"} (= kind "mine") "personal notes -> cli/north-mine.clj (@mine:<stem> facts)"
  ^{:line 1508 :file "/home/tom/code/north/src/north/main.bclj"} (= kind "predicate") "schema-as-facts -> north schema-seed (src/north/main.bclj cmd-schema-seed) / fram tell (cardinality/value_kind/acyclic)"
  ^{:line 1509 :file "/home/tom/code/north/src/north/main.bclj"} (= kind "topic") "topic grouping anchors (topic- prefix)"
  :else "(writer not curated — grep the coordination log for this kind's writer)"))

^{:line 1512 :file "/home/tom/code/north/src/north/main.bclj"} (defn- print-schema-kind [idx facts ^String kind]
  ^{:line 1513 :file "/home/tom/code/north/src/north/main.bclj"} (let [ksubs ^{:line 1513 :file "/home/tom/code/north/src/north/main.bclj"} (kind-subjects idx kind)
   total ^{:line 1514 :file "/home/tom/code/north/src/north/main.bclj"} (count ksubs)]
  ^{:line 1515 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1515 :file "/home/tom/code/north/src/north/main.bclj"} (= total 0) ^{:line 1516 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1516 :file "/home/tom/code/north/src/north/main.bclj"} (str "SCHEMA · " kind " — no subjects of this kind. `north schema` lists the kinds in use.")) ^{:line 1517 :file "/home/tom/code/north/src/north/main.bclj"} (let [fields ^{:line 1517 :file "/home/tom/code/north/src/north/main.bclj"} (schema-fields idx facts kind)
   req ^{:line 1518 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1518 :file "/home/tom/code/north/src/north/main.bclj"} (fn [fs] ^{:line 1518 :file "/home/tom/code/north/src/north/main.bclj"} (:required fs)) fields)
   opt ^{:line 1519 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1519 :file "/home/tom/code/north/src/north/main.bclj"} (fn [fs] ^{:line 1519 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1519 :file "/home/tom/code/north/src/north/main.bclj"} (:required fs))) fields)]
  ^{:line 1520 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1520 :file "/home/tom/code/north/src/north/main.bclj"} (str "SCHEMA · " kind " — " total " subjects · " ^{:line 1520 :file "/home/tom/code/north/src/north/main.bclj"} (count fields) " distinct predicates"))
  ^{:line 1521 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1521 :file "/home/tom/code/north/src/north/main.bclj"} (str "  REQUIRED — carried by ≥98% of " kind " subjects (≈ every one):"))
  ^{:line 1522 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [fs req]
  ^{:line 1523 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1523 :file "/home/tom/code/north/src/north/main.bclj"} (str "    " ^{:line 1523 :file "/home/tom/code/north/src/north/main.bclj"} (padr ^{:line 1523 :file "/home/tom/code/north/src/north/main.bclj"} (:pred fs) 20) " " ^{:line 1523 :file "/home/tom/code/north/src/north/main.bclj"} (:pct fs) "%" ^{:line 1523 :file "/home/tom/code/north/src/north/main.bclj"} (pred-ann idx ^{:line 1523 :file "/home/tom/code/north/src/north/main.bclj"} (:pred fs)))))
  ^{:line 1524 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1524 :file "/home/tom/code/north/src/north/main.bclj"} (empty? req) ^{:line 1524 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1524 :file "/home/tom/code/north/src/north/main.bclj"} (println "    (none)")))
  ^{:line 1525 :file "/home/tom/code/north/src/north/main.bclj"} (println "  OPTIONAL — coverage % of subjects that carry it:")
  ^{:line 1526 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [fs opt]
  ^{:line 1527 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1527 :file "/home/tom/code/north/src/north/main.bclj"} (str "    " ^{:line 1527 :file "/home/tom/code/north/src/north/main.bclj"} (padr ^{:line 1527 :file "/home/tom/code/north/src/north/main.bclj"} (:pred fs) 20) " " ^{:line 1527 :file "/home/tom/code/north/src/north/main.bclj"} (:pct fs) "%" ^{:line 1527 :file "/home/tom/code/north/src/north/main.bclj"} (pred-ann idx ^{:line 1527 :file "/home/tom/code/north/src/north/main.bclj"} (:pred fs)))))
  ^{:line 1528 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1528 :file "/home/tom/code/north/src/north/main.bclj"} (empty? opt) ^{:line 1528 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1528 :file "/home/tom/code/north/src/north/main.bclj"} (println "    (none)")))
  ^{:line 1529 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1529 :file "/home/tom/code/north/src/north/main.bclj"} (str "  written by: " ^{:line 1529 :file "/home/tom/code/north/src/north/main.bclj"} (kind-writer kind)))))))

^{:line 1533 :file "/home/tom/code/north/src/north/main.bclj"} (defn cmd-schema [^String log ^String kind]
  ^{:line 1534 :file "/home/tom/code/north/src/north/main.bclj"} (let [facts ^{:line 1534 :file "/home/tom/code/north/src/north/main.bclj"} (live-facts log)
   idx ^{:line 1535 :file "/home/tom/code/north/src/north/main.bclj"} (k/build-index facts)]
  ^{:line 1536 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1536 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1536 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? kind)) ^{:line 1537 :file "/home/tom/code/north/src/north/main.bclj"} (print-schema-kind idx facts kind) ^{:line 1538 :file "/home/tom/code/north/src/north/main.bclj"} (let [stats ^{:line 1538 :file "/home/tom/code/north/src/north/main.bclj"} (census idx facts)
   pred-subs ^{:line 1539 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1539 :file "/home/tom/code/north/src/north/main.bclj"} (fn [s] ^{:line 1540 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 1540 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 1540 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx s "cardinality")) ^{:line 1541 :file "/home/tom/code/north/src/north/main.bclj"} (or ^{:line 1541 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 1541 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx s "value_kind")) ^{:line 1542 :file "/home/tom/code/north/src/north/main.bclj"} (some? ^{:line 1542 :file "/home/tom/code/north/src/north/main.bclj"} (k/one-i idx s "acyclic"))))) ^{:line 1543 :file "/home/tom/code/north/src/north/main.bclj"} (:subjects idx))]
  ^{:line 1544 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1544 :file "/home/tom/code/north/src/north/main.bclj"} (str "SCHEMA — " ^{:line 1544 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1544 :file "/home/tom/code/north/src/north/main.bclj"} (:subjects idx)) " subjects / " ^{:line 1544 :file "/home/tom/code/north/src/north/main.bclj"} (count facts) " live facts across " ^{:line 1545 :file "/home/tom/code/north/src/north/main.bclj"} (count stats) " kinds"))
  ^{:line 1546 :file "/home/tom/code/north/src/north/main.bclj"} (doseq [ks stats]
  ^{:line 1547 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1547 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 1547 :file "/home/tom/code/north/src/north/main.bclj"} (padr ^{:line 1547 :file "/home/tom/code/north/src/north/main.bclj"} (:kind ks) 20) " " ^{:line 1547 :file "/home/tom/code/north/src/north/main.bclj"} (:subjects ks) " subjects · " ^{:line 1547 :file "/home/tom/code/north/src/north/main.bclj"} (:facts ks) " facts")))
  ^{:line 1548 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1548 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 1548 :file "/home/tom/code/north/src/north/main.bclj"} (padr "predicate-meta" 20) " " ^{:line 1548 :file "/home/tom/code/north/src/north/main.bclj"} (count pred-subs) " predicate(s) carry declared cardinality/value_kind/acyclic"))
  ^{:line 1555 :file "/home/tom/code/north/src/north/main.bclj"} (let [tlog ^{:line 1555 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/getenv-or "FRAM_TELEMETRY_LOG" "")]
  ^{:line 1556 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1556 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1556 :file "/home/tom/code/north/src/north/main.bclj"} (str/blank? tlog)) ^{:line 1556 :file "/home/tom/code/north/src/north/main.bclj"} (do
  ^{:line 1557 :file "/home/tom/code/north/src/north/main.bclj"} (let [coord-n ^{:line 1557 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1557 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/read-log log))
   telem-n ^{:line 1558 :file "/home/tom/code/north/src/north/main.bclj"} (count ^{:line 1558 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/read-log tlog))]
  ^{:line 1559 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1559 :file "/home/tom/code/north/src/north/main.bclj"} (str "  ── logs (on-disk fact-ops; unified in-store above) ──"))
  ^{:line 1560 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1560 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 1560 :file "/home/tom/code/north/src/north/main.bclj"} (padr "coordination" 20) " " coord-n " fact-ops  " log))
  ^{:line 1561 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1561 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 1561 :file "/home/tom/code/north/src/north/main.bclj"} (padr "telemetry" 20) " " telem-n " fact-ops  " tlog))
  ^{:line 1562 :file "/home/tom/code/north/src/north/main.bclj"} (println ^{:line 1562 :file "/home/tom/code/north/src/north/main.bclj"} (str "  " ^{:line 1562 :file "/home/tom/code/north/src/north/main.bclj"} (padr "total on-disk" 20) " " ^{:line 1562 :file "/home/tom/code/north/src/north/main.bclj"} (+ coord-n telem-n) " fact-ops boot-merged by :tx"))))))
  ^{:line 1564 :file "/home/tom/code/north/src/north/main.bclj"} (println "→ north schema <kind> for the field spec — required vs optional preds, coverage %, who writes it")))))

^{:line 1567 :file "/home/tom/code/north/src/north/main.bclj"} (defn- ^Boolean has-flag? [args ^String f]
  ^{:line 1568 :file "/home/tom/code/north/src/north/main.bclj"} (not ^{:line 1568 :file "/home/tom/code/north/src/north/main.bclj"} (empty? ^{:line 1568 :file "/home/tom/code/north/src/north/main.bclj"} (filterv ^{:line 1568 :file "/home/tom/code/north/src/north/main.bclj"} (fn [a] ^{:line 1568 :file "/home/tom/code/north/src/north/main.bclj"} (= a f)) args))))

^{:line 1570 :file "/home/tom/code/north/src/north/main.bclj"} (defn run [args ^String threads-dir ^String log]
  ^{:line 1571 :file "/home/tom/code/north/src/north/main.bclj"} (let [cmd ^{:line 1571 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1571 :file "/home/tom/code/north/src/north/main.bclj"} (empty? args) "" ^{:line 1571 :file "/home/tom/code/north/src/north/main.bclj"} (first args))]
  ^{:line 1572 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 1573 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "capture") ^{:line 1574 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1574 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1574 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 2) ^{:line 1575 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-capture threads-dir log ^{:line 1575 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 1) ^{:line 1575 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1575 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1575 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 3) ^{:line 1575 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 2) "personal")) ^{:line 1576 :file "/home/tom/code/north/src/north/main.bclj"} (println "usage: capture <title> [owner]"))
  ^{:line 1577 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "ready") ^{:line 1577 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-ready log ^{:line 1577 :file "/home/tom/code/north/src/north/main.bclj"} (has-flag? args "--all"))
  ^{:line 1578 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "blocked") ^{:line 1578 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-blocked log)
  ^{:line 1579 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "leverage") ^{:line 1579 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-leverage log)
  ^{:line 1580 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "next") ^{:line 1580 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-next log)
  ^{:line 1581 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "agenda") ^{:line 1581 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-agenda log)
  ^{:line 1582 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "board") ^{:line 1582 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-board log ^{:line 1582 :file "/home/tom/code/north/src/north/main.bclj"} (has-flag? args "--all"))
  ^{:line 1583 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "plate") ^{:line 1583 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-board log ^{:line 1583 :file "/home/tom/code/north/src/north/main.bclj"} (has-flag? args "--all"))
  ^{:line 1584 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "schema") ^{:line 1584 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-schema log ^{:line 1584 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1584 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1584 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 2) ^{:line 1584 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 1) ""))
  ^{:line 1585 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "needs-review") ^{:line 1585 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-needs-review log)
  ^{:line 1586 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "audit") ^{:line 1586 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-audit log)
  ^{:line 1587 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "resolve") ^{:line 1588 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1588 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1588 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 2) ^{:line 1589 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-resolve log ^{:line 1589 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 1)) ^{:line 1590 :file "/home/tom/code/north/src/north/main.bclj"} (println "usage: resolve <@handle|@id>"))
  ^{:line 1591 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "done-bars") ^{:line 1592 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1592 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1592 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 2) ^{:line 1593 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-done-bars log ^{:line 1593 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 1)) ^{:line 1594 :file "/home/tom/code/north/src/north/main.bclj"} (println "usage: done-bars <@id|@handle>"))
  ^{:line 1595 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "validate") ^{:line 1595 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-validate log)
  ^{:line 1596 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "schema-seed") ^{:line 1596 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-schema-seed log ^{:line 1596 :file "/home/tom/code/north/src/north/main.bclj"} (has-flag? args "--execute"))
  ^{:line 1597 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "tools") ^{:line 1597 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-tools)
  ^{:line 1598 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "doctor") ^{:line 1598 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-doctor threads-dir log)
  ^{:line 1599 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "heal") ^{:line 1599 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-heal threads-dir log ^{:line 1599 :file "/home/tom/code/north/src/north/main.bclj"} (has-flag? args "--adopt") ^{:line 1599 :file "/home/tom/code/north/src/north/main.bclj"} (has-flag? args "--resurrect"))
  ^{:line 1600 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "boot") ^{:line 1600 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-boot threads-dir log)
  ^{:line 1601 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "json") ^{:line 1602 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-json log ^{:line 1602 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1602 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 1602 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 1) ^{:line 1602 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 1) "") ^{:line 1603 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1603 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 1603 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 2) ^{:line 1603 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 2) "") ^{:line 1604 :file "/home/tom/code/north/src/north/main.bclj"} (has-flag? args "--all"))
  ^{:line 1605 :file "/home/tom/code/north/src/north/main.bclj"} (= cmd "clock") ^{:line 1606 :file "/home/tom/code/north/src/north/main.bclj"} (let [sub ^{:line 1606 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1606 :file "/home/tom/code/north/src/north/main.bclj"} (> ^{:line 1606 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 1) ^{:line 1606 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 1) "status")]
  ^{:line 1607 :file "/home/tom/code/north/src/north/main.bclj"} (cond
  ^{:line 1608 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "start") ^{:line 1609 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1609 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1609 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 3) ^{:line 1610 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-clock-start log ^{:line 1610 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 2)) ^{:line 1611 :file "/home/tom/code/north/src/north/main.bclj"} (println "usage: clock start <thread-id>"))
  ^{:line 1612 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "stop") ^{:line 1612 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-clock-stop log)
  ^{:line 1613 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "orphan") ^{:line 1614 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1614 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1614 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 3) ^{:line 1615 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-clock-orphan log ^{:line 1615 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 2)) ^{:line 1616 :file "/home/tom/code/north/src/north/main.bclj"} (println "usage: clock orphan <agent-id>"))
  ^{:line 1617 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "status") ^{:line 1617 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-clock-status log)
  ^{:line 1618 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "report") ^{:line 1618 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-clock-report log)
  ^{:line 1619 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "today") ^{:line 1619 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-clock-today log)
  ^{:line 1620 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "week") ^{:line 1620 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-clock-week log)
  ^{:line 1621 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "sync") ^{:line 1621 :file "/home/tom/code/north/src/north/main.bclj"} (cmd-clock-sync log)
  ^{:line 1622 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "map") ^{:line 1623 :file "/home/tom/code/north/src/north/main.bclj"} (if ^{:line 1623 :file "/home/tom/code/north/src/north/main.bclj"} (>= ^{:line 1623 :file "/home/tom/code/north/src/north/main.bclj"} (count args) 4) ^{:line 1624 :file "/home/tom/code/north/src/north/main.bclj"} (cf/cmd-map ^{:line 1624 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/time-dir) ^{:line 1624 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 2) ^{:line 1624 :file "/home/tom/code/north/src/north/main.bclj"} (nth args 3)) ^{:line 1625 :file "/home/tom/code/north/src/north/main.bclj"} (println "usage: clock map <owner> <project-id>"))
  ^{:line 1626 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "projects") ^{:line 1626 :file "/home/tom/code/north/src/north/main.bclj"} (cf/cmd-projects)
  ^{:line 1627 :file "/home/tom/code/north/src/north/main.bclj"} (= sub "workspaces") ^{:line 1627 :file "/home/tom/code/north/src/north/main.bclj"} (cf/cmd-workspaces)
  :else ^{:line 1628 :file "/home/tom/code/north/src/north/main.bclj"} (println "usage: clock start <id> | stop | orphan <agent-id> | status | report | today | week | sync | map <owner> <project-id> | projects | workspaces")))
  :else ^{:line 1629 :file "/home/tom/code/north/src/north/main.bclj"} (println "north usage: capture <title> [owner] | ready [--all] | blocked | leverage | next | agenda | board [--all] | schema | needs-review | audit | resolve <@handle|@id> | validate | schema-seed [--dry-run|--execute] | tools | doctor | heal | boot | listen <agent-id> | json <...> | clock <start|stop|orphan|status|report|today|week|sync|map|projects|workspaces>   (board/ready default to a curated top slice; --all for the full dump. engine verbs import/export/show/set/tell/retract/merge route to fram; untell = legacy alias of retract)"))))

^{:line 1631 :file "/home/tom/code/north/src/north/main.bclj"} (defn -main [& args]
  ^{:line 1632 :file "/home/tom/code/north/src/north/main.bclj"} (run ^{:line 1632 :file "/home/tom/code/north/src/north/main.bclj"} (vec args) ^{:line 1632 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/threads-dir) ^{:line 1632 :file "/home/tom/code/north/src/north/main.bclj"} (fram.rt/log-path)))
