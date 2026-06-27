(ns bridge.bridge
  (:require [bridge.rt :as rt]
            [clojure.string :as str]))

^{:line 44 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord Node [id type attrs graph])

(defn node-id [r] (:id r))

(defn node-type [r] (:type r))

(defn node-attrs [r] (:attrs r))

(defn node-graph [r] (:graph r))

^{:line 45 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord Edge [from pred to graph kind])

(defn edge-from [r] (:from r))

(defn edge-pred [r] (:pred r))

(defn edge-to [r] (:to r))

(defn edge-graph [r] (:graph r))

(defn edge-kind [r] (:kind r))

^{:line 46 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord Graph [nodes edges])

(defn graph-nodes [r] (:nodes r))

(defn graph-edges [r] (:edges r))

^{:line 47 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord GraphSpec [name port])

(defn graphspec-name [r] (:name r))

(defn graphspec-port [r] (:port r))

^{:line 48 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord TaggedGraph [name graph])

(defn taggedgraph-name [r] (:name r))

(defn taggedgraph-graph [r] (:graph r))

^{:line 49 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord Federated [graphs nodes edges])

(defn federated-graphs [r] (:graphs r))

(defn federated-nodes [r] (:nodes r))

(defn federated-edges [r] (:edges r))

^{:line 50 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord WorkResult [nodes edges])

(defn workresult-nodes [r] (:nodes r))

(defn workresult-edges [r] (:edges r))

^{:line 51 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord Lease [holder exp epoch])

(defn lease-holder [r] (:holder r))

(defn lease-exp [r] (:exp r))

(defn lease-epoch [r] (:epoch r))

^{:line 52 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord PresenceRow [uuid online expires_s roles model effort lifecycle current_thread active_workflow task cost_usd stream_age_s has_stream pinned spawned_at generation staleness_score staleness_bucket])

(defn presencerow-uuid [r] (:uuid r))

(defn presencerow-online [r] (:online r))

(defn presencerow-expires_s [r] (:expires_s r))

(defn presencerow-roles [r] (:roles r))

(defn presencerow-model [r] (:model r))

(defn presencerow-effort [r] (:effort r))

(defn presencerow-lifecycle [r] (:lifecycle r))

(defn presencerow-current_thread [r] (:current_thread r))

(defn presencerow-active_workflow [r] (:active_workflow r))

(defn presencerow-task [r] (:task r))

(defn presencerow-cost_usd [r] (:cost_usd r))

(defn presencerow-stream_age_s [r] (:stream_age_s r))

(defn presencerow-has_stream [r] (:has_stream r))

^{:line 57 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord TapeEvent [t kind id from to label agent cost])

(defn tapeevent-t [r] (:t r))

(defn tapeevent-kind [r] (:kind r))

(defn tapeevent-id [r] (:id r))

(defn tapeevent-from [r] (:from r))

(defn tapeevent-to [r] (:to r))

(defn tapeevent-label [r] (:label r))

(defn tapeevent-agent [r] (:agent r))

(defn tapeevent-cost [r] (:cost r))

^{:line 60 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord Timetape [now mins events])

(defn timetape-now [r] (:now r))

(defn timetape-mins [r] (:mins r))

(defn timetape-events [r] (:events r))

^{:line 61 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord SubjGroup [subj rows])

(defn subjgroup-subj [r] (:subj r))

(defn subjgroup-rows [r] (:rows r))

^{:line 64 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord Decision [id chosen options tradeoffs rationale led_to])

(defn decision-id [r] (:id r))

(defn decision-chosen [r] (:chosen r))

(defn decision-options [r] (:options r))

(defn decision-tradeoffs [r] (:tradeoffs r))

(defn decision-rationale [r] (:rationale r))

(defn decision-led_to [r] (:led_to r))

^{:line 70 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (def DECISIONS-PORT 7981)

^{:line 75 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (def GRAPHS ^{:line 76 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [^{:line 76 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->GraphSpec "fleet" 7978) ^{:line 77 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->GraphSpec "code" 7979) ^{:line 78 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->GraphSpec "board" 7977) ^{:line 79 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->GraphSpec "attention" 7980)])

^{:line 83 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Boolean ref-obj? [^String o]
  ^{:line 84 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 84 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/starts-with? o "@") ^{:line 84 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nil? ^{:line 84 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (re-find #"\s" o))))

^{:line 86 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^String type-of [^String id]
  ^{:line 87 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [body ^{:line 87 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (subs id 1)
   i ^{:line 88 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/index-of body ":")]
  ^{:line 89 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (cond
  ^{:line 90 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? i) ^{:line 90 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (subs body 0 i)
  ^{:line 91 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ^{:line 91 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (re-matches #"\d{4}-\d{2}-\d{2}.*" body)) "thread"
  :else "node")))

^{:line 94 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^String basename [^String pth]
  ^{:line 95 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [i ^{:line 95 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/last-index-of pth "/")]
  ^{:line 96 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 96 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? i) ^{:line 96 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (subs pth ^{:line 96 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (+ i 1)) pth)))

^{:line 98 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Boolean member? [v ^String x]
  ^{:line 99 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 99 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [acc y] ^{:line 99 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or acc ^{:line 99 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= y x))) false v))

^{:line 104 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord Acc [nodes edges])

(defn acc-nodes [r] (:nodes r))

(defn acc-edges [r] (:edges r))

^{:line 106 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Acc ensure-node [^Acc acc ^String id]
  ^{:line 107 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 107 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ^{:line 107 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get ^{:line 107 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes acc) id)) acc ^{:line 109 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Acc ^{:line 109 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc ^{:line 109 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes acc) id ^{:line 109 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Node id ^{:line 109 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (type-of id) ^{:line 109 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {} nil)) ^{:line 109 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges acc))))

^{:line 111 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Acc add-edge [^Acc acc ^Edge e]
  ^{:line 112 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Acc ^{:line 112 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes acc) ^{:line 112 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (conj ^{:line 112 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges acc) e)))

^{:line 115 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Acc put-attr [^Acc acc ^String id ^String pred ^String o]
  ^{:line 116 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [n ^{:line 116 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get ^{:line 116 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes acc) id)]
  ^{:line 117 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Acc ^{:line 117 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc ^{:line 117 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes acc) id ^{:line 117 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Node ^{:line 117 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:id n) ^{:line 117 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:type n) ^{:line 117 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc ^{:line 117 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:attrs n) pred o) ^{:line 117 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:graph n))) ^{:line 118 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges acc))))

^{:line 120 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Acc fold-tuple [^Acc acc t]
  ^{:line 121 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [s ^{:line 121 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 0)
   pred ^{:line 121 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 1)
   o ^{:line 121 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 2)
   acc1 ^{:line 122 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (ensure-node acc s)]
  ^{:line 123 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 123 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (ref-obj? o) ^{:line 124 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (add-edge ^{:line 124 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (ensure-node acc1 o) ^{:line 124 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Edge s pred o nil nil)) ^{:line 125 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (put-attr acc1 s pred o))))

^{:line 129 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Boolean holds-edge? [edges ^String ae ^String re]
  ^{:line 130 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 130 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [acc e] ^{:line 131 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or acc ^{:line 131 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 131 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= ^{:line 131 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:from e) ae) ^{:line 131 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 131 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= ^{:line 131 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:pred e) "holds") ^{:line 131 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= ^{:line 131 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:to e) re))))) false edges))

^{:line 134 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Acc stamp-role [^Acc acc ^String ae ^String slug]
  ^{:line 135 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [n ^{:line 135 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get ^{:line 135 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes acc) ae)
   cur ^{:line 136 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get ^{:line 136 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:attrs n) "role")]
  ^{:line 137 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Acc ^{:line 137 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc ^{:line 137 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes acc) ae ^{:line 138 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Node ^{:line 138 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:id n) ^{:line 138 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:type n) ^{:line 138 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc ^{:line 138 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:attrs n) "role" ^{:line 138 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 138 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? cur) cur slug)) ^{:line 138 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:graph n))) ^{:line 139 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges acc))))

^{:line 141 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Acc enrich [^Acc acc t]
  ^{:line 142 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [s ^{:line 142 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 0)
   p ^{:line 142 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 1)
   o ^{:line 142 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 2)]
  ^{:line 143 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 143 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 143 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= p "lease") ^{:line 143 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/starts-with? s "@lease:role:")) ^{:line 144 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [slug ^{:line 144 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (subs s ^{:line 144 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (count "@lease:role:"))
   holder ^{:line 145 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (first ^{:line 145 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/split o #"\|"))
   ae ^{:line 146 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str "@agent:" holder)
   re ^{:line 147 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str "@role:" slug)
   acc1 ^{:line 148 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (stamp-role ^{:line 148 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (ensure-node ^{:line 148 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (ensure-node acc ae) re) ae slug)]
  ^{:line 149 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 149 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (holds-edge? ^{:line 149 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges acc1) ae re) acc1 ^{:line 151 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (add-edge acc1 ^{:line 151 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Edge ae "holds" re nil nil)))) acc)))

^{:line 154 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn snapshot [port]
  ^{:line 155 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [tuples ^{:line 155 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/all-triples port)]
  ^{:line 156 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 156 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nil? tuples) nil ^{:line 158 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [acc0 ^{:line 158 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce fold-tuple ^{:line 158 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Acc ^{:line 158 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {} ^{:line 158 :file "/home/tom/code/framescope/bridge/bridge.bclj"} []) tuples)
   acc1 ^{:line 159 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce enrich acc0 tuples)]
  ^{:line 160 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Graph ^{:line 160 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 160 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vals ^{:line 160 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes acc1))) ^{:line 160 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges acc1))))))

^{:line 162 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Graph snapshot-or-empty [port]
  ^{:line 163 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [g ^{:line 163 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (snapshot port)]
  ^{:line 163 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 163 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nil? g) ^{:line 163 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Graph ^{:line 163 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [] ^{:line 163 :file "/home/tom/code/framescope/bridge/bridge.bclj"} []) g)))

^{:line 166 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord WorkAcc [mods edges])

(defn workacc-mods [r] (:mods r))

(defn workacc-edges [r] (:edges r))

^{:line 168 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Edge working-edge [^String u ^String to]
  ^{:line 169 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Edge ^{:line 169 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str "@agent:" u) "working_on" to "work" "working"))

^{:line 171 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^WorkAcc work-step [idx ^WorkAcc wa ^String u]
  ^{:line 172 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [pth ^{:line 172 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/last-edit-file u)]
  ^{:line 173 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 173 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nil? pth) wa ^{:line 175 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [b ^{:line 175 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (basename pth)
   from-idx ^{:line 176 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get idx b)
   from-synth ^{:line 177 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get ^{:line 177 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:mods wa) b)]
  ^{:line 178 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (cond
  ^{:line 179 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? from-idx) ^{:line 180 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->WorkAcc ^{:line 180 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:mods wa) ^{:line 180 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (conj ^{:line 180 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges wa) ^{:line 180 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (working-edge u from-idx)))
  ^{:line 181 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? from-synth) ^{:line 182 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->WorkAcc ^{:line 182 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:mods wa) ^{:line 182 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (conj ^{:line 182 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges wa) ^{:line 182 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (working-edge u ^{:line 182 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:id from-synth))))
  :else ^{:line 184 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [mid ^{:line 184 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str "@module:" b)]
  ^{:line 185 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->WorkAcc ^{:line 185 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc ^{:line 185 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:mods wa) b ^{:line 185 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Node mid "module" ^{:line 185 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {"file" pth} "work")) ^{:line 186 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (conj ^{:line 186 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges wa) ^{:line 186 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (working-edge u mid)))))))))

^{:line 188 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^WorkResult working-edges [nodes uuids]
  ^{:line 189 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [idx ^{:line 189 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (into ^{:line 189 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {} ^{:line 189 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (for [n nodes
   :let [f ^{:line 190 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get ^{:line 190 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:attrs n) "file")]
   :when ^{:line 191 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? f)]
  ^{:line 192 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [^{:line 192 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (basename f) ^{:line 192 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:id n)]))
   wa ^{:line 193 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 193 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [acc u] ^{:line 193 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (work-step idx acc u)) ^{:line 194 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->WorkAcc ^{:line 194 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {} ^{:line 194 :file "/home/tom/code/framescope/bridge/bridge.bclj"} []) uuids)]
  ^{:line 195 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->WorkResult ^{:line 195 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 195 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vals ^{:line 195 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:mods wa))) ^{:line 195 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges wa))))

^{:line 198 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Graph tag-graph [^String g ^Graph gr]
  ^{:line 199 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Graph ^{:line 199 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapv ^{:line 199 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [n] ^{:line 199 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Node ^{:line 199 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:id n) ^{:line 199 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:type n) ^{:line 199 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:attrs n) g)) ^{:line 199 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes gr)) ^{:line 200 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapv ^{:line 200 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [e] ^{:line 200 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Edge ^{:line 200 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:from e) ^{:line 200 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:pred e) ^{:line 200 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:to e) g ^{:line 200 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:kind e))) ^{:line 200 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges gr))))

^{:line 202 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn dedup-by-id [ns]
  ^{:line 203 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 203 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vals ^{:line 203 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 203 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [m n] ^{:line 204 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 204 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ^{:line 204 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get m ^{:line 204 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:id n))) m ^{:line 204 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc m ^{:line 204 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:id n) n))) ^{:line 205 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {} ns))))

^{:line 207 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Federated federated [graph-names]
  ^{:line 208 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [sel ^{:line 208 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 208 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 208 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? graph-names) ^{:line 208 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (> ^{:line 208 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (count graph-names) 0)) ^{:line 209 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (filterv ^{:line 209 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [g] ^{:line 209 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (member? graph-names ^{:line 209 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:name g))) GRAPHS) GRAPHS)
   tagged ^{:line 211 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 211 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [acc g] ^{:line 212 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [snap ^{:line 212 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (snapshot ^{:line 212 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:port g))]
  ^{:line 213 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 213 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nil? snap) acc ^{:line 215 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (conj acc ^{:line 215 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->TaggedGraph ^{:line 215 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:name g) ^{:line 215 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (tag-graph ^{:line 215 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:name g) snap)))))) ^{:line 216 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [] sel)
   live-names ^{:line 217 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapv ^{:line 217 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [tg] ^{:line 217 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:name tg)) tagged)
   nodes0 ^{:line 218 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 218 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapcat ^{:line 218 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [tg] ^{:line 218 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes ^{:line 218 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:graph tg))) tagged))
   edges0 ^{:line 219 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 219 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapcat ^{:line 219 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [tg] ^{:line 219 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges ^{:line 219 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:graph tg))) tagged))
   agent-nodes ^{:line 220 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (filterv ^{:line 220 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [n] ^{:line 220 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= "agent" ^{:line 220 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:type n))) nodes0)
   uuids ^{:line 221 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 221 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (distinct ^{:line 221 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapv ^{:line 221 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [n] ^{:line 221 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (subs ^{:line 221 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:id n) ^{:line 221 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (count "@agent:"))) agent-nodes)))
   work ^{:line 222 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (working-edges nodes0 uuids)
   nodes ^{:line 223 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (dedup-by-id ^{:line 223 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 223 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (concat nodes0 ^{:line 223 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:nodes work))))]
  ^{:line 224 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Federated live-names nodes ^{:line 224 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 224 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (concat edges0 ^{:line 224 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:edges work))))))

^{:line 227 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn decode-lease [v]
  ^{:line 228 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 228 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nil? v) nil ^{:line 230 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [parts ^{:line 230 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/split v #"\|")]
  ^{:line 231 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 231 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (>= ^{:line 231 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (count parts) 2) ^{:line 232 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [e ^{:line 232 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (parse-long ^{:line 232 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth parts 1))
   ep ^{:line 233 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (parse-long ^{:line 233 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 233 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (>= ^{:line 233 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (count parts) 3) ^{:line 233 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth parts 2) "0"))]
  ^{:line 234 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 234 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? e) ^{:line 235 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Lease ^{:line 235 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth parts 0) e ^{:line 235 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 235 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ep) ep 0)) nil)) nil))))

^{:line 239 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn sorted-roles [vs]
  ^{:line 240 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 240 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (sort ^{:line 240 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapv ^{:line 240 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [r] ^{:line 240 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (subs r 6)) ^{:line 241 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (filterv ^{:line 241 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [r] ^{:line 241 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/starts-with? r "@role:")) vs)))))

^{:line 243 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^PresenceRow build-row [port pair now costs]
  ^{:line 244 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [se ^{:line 244 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth pair 0)
   h ^{:line 245 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth pair 1)
   ld ^{:line 246 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (decode-lease ^{:line 246 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/resolved port ^{:line 246 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str "@lease:session:" h) "lease"))
   live? ^{:line 247 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 247 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ld) ^{:line 247 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (> ^{:line 247 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:exp ld) now))
   expires ^{:line 248 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 248 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 248 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ld) ^{:line 248 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (> ^{:line 248 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:exp ld) now)) ^{:line 248 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (int ^{:line 248 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (/ ^{:line 248 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (- ^{:line 248 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:exp ld) now) 1000)) nil)
   ae ^{:line 249 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str "@agent:" h)
   c ^{:line 250 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get costs h)
   pinned (= "true" (rt/resolved port ae "pinned"))
   spawned-at (rt/resolved port ae "spawned_at")
   gen-s (rt/resolved port ae "generation")
   gen (or (when gen-s (parse-long gen-s)) 0)
   last-run (rt/resolved port ae "last_run_at")
   idle-h (when last-run
            (try (/ (- now (.toEpochMilli (java.time.Instant/parse last-run))) 3600000.0)
                 (catch Exception _ nil)))
   idle-score (if idle-h (min 1.0 (/ idle-h 24.0)) 0.5)
   gen-score (min 1.0 (/ (double gen) 5.0))
   score (+ (* 0.53 idle-score) (* 0.47 gen-score))
   bucket (cond pinned "PINNED" (< score 0.3) "GREEN" (< score 0.7) "YELLOW" :else "RED")]
  (->PresenceRow h (boolean live?) expires
    (sorted-roles (rt/resolved-many port ae "holds"))
    (rt/resolved port ae "model")
    (rt/resolved port ae "effort")
    (rt/resolved port ae "lifecycle")
    (rt/resolved port se "current_thread")
    (rt/resolved port se "active_workflow")
    (rt/resolved port se "task")
    (if (some? c) c 0.0)
    (rt/stream-age-s h)
    (rt/stream-exists? h)
    pinned spawned-at gen (double score) bucket)))


^{:line 266 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Boolean focus? [^PresenceRow r]
  ^{:line 267 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or ^{:line 267 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ^{:line 267 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:active_workflow r)) ^{:line 267 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or ^{:line 267 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ^{:line 267 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:current_thread r)) ^{:line 267 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ^{:line 267 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:task r)))))

^{:line 268 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn p-online [^PresenceRow r]
  ^{:line 268 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 268 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:online r) 0 1))

^{:line 269 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn p-focus [^PresenceRow r]
  ^{:line 269 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 269 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (focus? r) 0 1))

^{:line 270 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn p-age [^PresenceRow r]
  ^{:line 270 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [a ^{:line 270 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:stream_age_s r)]
  ^{:line 270 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 270 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? a) a 1000000000)))

^{:line 272 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^PresenceRow richer [^PresenceRow a ^PresenceRow b]
  ^{:line 273 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (cond
  ^{:line 274 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (not ^{:line 274 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= ^{:line 274 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-online a) ^{:line 274 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-online b))) ^{:line 274 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 274 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (< ^{:line 274 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-online a) ^{:line 274 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-online b)) a b)
  ^{:line 275 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (not ^{:line 275 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= ^{:line 275 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-focus a) ^{:line 275 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-focus b))) ^{:line 275 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 275 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (< ^{:line 275 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-focus a) ^{:line 275 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-focus b)) a b)
  :else ^{:line 276 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 276 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (<= ^{:line 276 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-age a) ^{:line 276 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-age b)) a b)))

^{:line 278 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn group-by-uuid [rows]
  ^{:line 279 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [m ^{:line 279 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 279 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [m r] ^{:line 280 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc m ^{:line 280 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:uuid r) ^{:line 280 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (conj ^{:line 280 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [g ^{:line 280 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get m ^{:line 280 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:uuid r))]
  ^{:line 280 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 280 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? g) g ^{:line 280 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [])) r))) ^{:line 281 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {} rows)]
  ^{:line 282 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 282 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vals m))))

^{:line 284 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn dedup-presence [rows]
  ^{:line 285 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [best ^{:line 285 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapv ^{:line 285 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [grp] ^{:line 285 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce richer ^{:line 285 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth grp 0) grp)) ^{:line 286 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (group-by-uuid rows))]
  ^{:line 287 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 287 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (sort-by ^{:line 287 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [r] ^{:line 287 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [^{:line 287 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (p-online r) ^{:line 287 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 287 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:has_stream r) 0 1) ^{:line 287 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:uuid r)]) best))))

^{:line 290 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn presence [port]
  ^{:line 291 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [now ^{:line 291 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/now-ms)
   costs ^{:line 292 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/agent-costs port)
   rows ^{:line 293 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapv ^{:line 293 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [pair] ^{:line 293 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (build-row port pair now costs)) ^{:line 294 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/agents port))]
  ^{:line 295 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (dedup-presence rows)))

^{:line 298 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^String clip [s n]
  ^{:line 299 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [s2 ^{:line 299 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 299 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? s) s "")]
  ^{:line 300 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 300 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (> ^{:line 300 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (count s2) n) ^{:line 300 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str ^{:line 300 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (subs s2 0 n) "…") s2)))

^{:line 302 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn attr [rows ^String p]
  ^{:line 303 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 303 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [acc t] ^{:line 304 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 304 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? acc) acc ^{:line 304 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 304 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= ^{:line 304 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 1) p) ^{:line 304 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 2) acc))) nil rows))

^{:line 307 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn cost-of [s]
  ^{:line 308 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 308 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? s) ^{:line 308 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [d ^{:line 308 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (parse-double s)]
  ^{:line 308 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 308 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? d) d 0.0)) 0.0))

^{:line 310 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ev [^String subj rows]
  ^{:line 311 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (cond
  ^{:line 312 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/starts-with? subj "@msg:") ^{:line 313 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [t ^{:line 313 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or ^{:line 313 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/parse-iso-ms ^{:line 313 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "sent_at")) ^{:line 313 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/parse-id-ms subj))]
  ^{:line 314 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 314 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? t) ^{:line 315 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->TapeEvent t "msg" subj ^{:line 315 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "from") ^{:line 315 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "to") ^{:line 316 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (clip ^{:line 316 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or ^{:line 316 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "subject") ^{:line 316 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or ^{:line 316 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "body") "(message)")) 90) nil nil) nil))
  ^{:line 318 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/starts-with? subj "@run:") ^{:line 319 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [t ^{:line 319 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/parse-iso-ms ^{:line 319 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "ended_at"))]
  ^{:line 320 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 320 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? t) ^{:line 321 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->TapeEvent t "run" subj nil nil nil ^{:line 321 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "agent") ^{:line 321 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (cost-of ^{:line 321 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "cost_usd"))) nil))
  ^{:line 323 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/starts-with? subj "@session:") ^{:line 324 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [t ^{:line 324 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/parse-iso-ms ^{:line 324 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "started_at"))]
  ^{:line 325 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 325 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? t) ^{:line 326 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->TapeEvent t "session" subj nil nil ^{:line 327 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (clip ^{:line 327 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or ^{:line 327 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "active_workflow") ^{:line 327 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or ^{:line 327 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "current_thread") ^{:line 327 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or ^{:line 327 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "task") "(session)"))) 90) ^{:line 328 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "agent") nil) nil))
  :else nil))

^{:line 332 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn group-tuples [tuples]
  ^{:line 333 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [m ^{:line 333 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 333 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [m t] ^{:line 334 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [s ^{:line 334 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 0)
   g ^{:line 334 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get m s)]
  ^{:line 335 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 335 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? g) ^{:line 336 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc m s ^{:line 336 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->SubjGroup s ^{:line 336 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (conj ^{:line 336 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:rows g) t))) ^{:line 337 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc m s ^{:line 337 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->SubjGroup s ^{:line 337 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [t]))))) ^{:line 338 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {} tuples)]
  ^{:line 339 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 339 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vals m))))

^{:line 342 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn attrs-all [rows ^String p]
  ^{:line 343 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 343 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (for [t rows
   :when ^{:line 343 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= ^{:line 343 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 1) p)]
  ^{:line 343 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 2))))

^{:line 345 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn seq-of [rows]
  ^{:line 346 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [s ^{:line 346 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "seq")]
  ^{:line 347 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 347 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? s) ^{:line 347 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [n ^{:line 347 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (parse-long s)]
  ^{:line 347 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 347 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? n) n 0)) 0)))

^{:line 349 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Boolean decision-of? [^String subj ^String agent rows]
  ^{:line 350 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 350 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/starts-with? subj "@decision:") ^{:line 350 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= agent ^{:line 350 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "agent"))))

^{:line 352 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Decision group->decision [^SubjGroup g]
  ^{:line 353 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [rows ^{:line 353 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:rows g)]
  ^{:line 354 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Decision ^{:line 354 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:subj g) ^{:line 354 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "chosen") ^{:line 354 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attrs-all rows "options") ^{:line 355 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "tradeoffs") ^{:line 355 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attr rows "rationale") ^{:line 355 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (attrs-all rows "led_to"))))

^{:line 360 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn distill! [^String agent window]
  ^{:line 361 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [_ ^{:line 361 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/run-distiller! agent window DECISIONS-PORT)
   raw ^{:line 362 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/all-triples DECISIONS-PORT)
   tuples ^{:line 363 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 363 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nil? raw) ^{:line 363 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [] raw)
   groups ^{:line 364 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (group-tuples tuples)
   mine ^{:line 365 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (filterv ^{:line 365 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [g] ^{:line 365 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (decision-of? ^{:line 365 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:subj g) agent ^{:line 365 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:rows g))) groups)
   sorted ^{:line 366 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 366 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (sort-by ^{:line 366 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [g] ^{:line 366 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (seq-of ^{:line 366 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:rows g))) mine))]
  ^{:line 367 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapv group->decision sorted)))

^{:line 369 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Timetape timetape [port mins]
  ^{:line 370 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [raw ^{:line 370 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/all-triples port)
   tuples ^{:line 371 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 371 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nil? raw) ^{:line 371 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [] raw)
   now ^{:line 372 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/now-ms)
   cutoff ^{:line 373 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (- now ^{:line 373 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (* mins 60000))
   groups ^{:line 374 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (group-tuples tuples)
   events ^{:line 375 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 375 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [acc g] ^{:line 376 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [e ^{:line 376 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (ev ^{:line 376 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:subj g) ^{:line 376 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:rows g))]
  ^{:line 377 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 377 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 377 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? e) ^{:line 377 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (>= ^{:line 377 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:t e) cutoff)) ^{:line 377 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (conj acc e) acc))) ^{:line 378 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [] groups)]
  ^{:line 379 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Timetape now mins ^{:line 379 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 379 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (sort-by ^{:line 379 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [e] ^{:line 379 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:t e)) events)))))

^{:line 389 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord Predicate [name cardinality value_kind domain count])

(defn predicate-name [r] (:name r))

(defn predicate-cardinality [r] (:cardinality r))

(defn predicate-value_kind [r] (:value_kind r))

(defn predicate-domain [r] (:domain r))

(defn predicate-count [r] (:count r))

^{:line 393 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defrecord PredAcc [objs sv])

(defn predacc-objs [r] (:objs r))

(defn predacc-sv [r] (:sv r))

^{:line 398 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^PredAcc pred-step [^PredAcc acc t]
  ^{:line 399 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [s ^{:line 399 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 0)
   p ^{:line 399 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 1)
   o ^{:line 399 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 2)
   os ^{:line 400 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [cur ^{:line 400 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get ^{:line 400 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:objs acc) p)]
  ^{:line 400 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 400 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? cur) cur ^{:line 400 :file "/home/tom/code/framescope/bridge/bridge.bclj"} []))
   key ^{:line 401 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str p "\u0000" s)
   svmap ^{:line 402 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [cur ^{:line 402 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get ^{:line 402 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:sv acc) key)]
  ^{:line 402 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 402 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? cur) cur ^{:line 402 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {}))]
  ^{:line 403 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->PredAcc ^{:line 404 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc ^{:line 404 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:objs acc) p ^{:line 404 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (conj os o)) ^{:line 405 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc ^{:line 405 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:sv acc) key ^{:line 405 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (assoc svmap o 1)))))

^{:line 407 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^String classify-kind [objs]
  ^{:line 408 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [refs ^{:line 408 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (count ^{:line 408 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (filterv ref-obj? objs))]
  ^{:line 409 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (cond
  ^{:line 410 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= refs ^{:line 410 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (count objs)) "ref"
  ^{:line 411 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= refs 0) "literal"
  :else "mixed")))

^{:line 415 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Boolean multi-pred? [sv ^String p]
  ^{:line 416 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 416 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [acc kv] ^{:line 417 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [key ^{:line 417 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth kv 0)
   vals ^{:line 417 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth kv 1)]
  ^{:line 418 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or acc ^{:line 418 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 418 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/starts-with? key ^{:line 418 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str p "\u0000")) ^{:line 418 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (> ^{:line 418 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (count vals) 1))))) false ^{:line 419 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec sv)))

^{:line 422 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn domain-sample [tuples ^String p]
  ^{:line 423 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 423 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [acc t] ^{:line 424 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 424 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? acc) acc ^{:line 424 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 424 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= ^{:line 424 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 1) p) ^{:line 424 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 0) acc))) nil tuples))

^{:line 432 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^String pred-node [^String pname]
  ^{:line 432 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str "@pred:" pname))

^{:line 434 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn override-of [tuples ^String pname ^String field]
  ^{:line 435 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [node ^{:line 435 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (pred-node pname)
   op ^{:line 435 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str "schema_" field)]
  ^{:line 436 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce ^{:line 436 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [acc t] ^{:line 437 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 437 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 437 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= ^{:line 437 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 0) node) ^{:line 437 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= ^{:line 437 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 1) op)) ^{:line 437 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nth t 2) acc)) nil tuples)))

^{:line 440 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn schema-of [port]
  ^{:line 441 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [raw ^{:line 441 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/all-triples port)
   tuples ^{:line 442 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 442 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nil? raw) ^{:line 442 :file "/home/tom/code/framescope/bridge/bridge.bclj"} [] raw)
   acc ^{:line 443 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (reduce pred-step ^{:line 443 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->PredAcc ^{:line 443 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {} ^{:line 443 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {}) tuples)
   preds ^{:line 444 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (vec ^{:line 444 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (sort ^{:line 444 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (keys ^{:line 444 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:objs acc))))]
  ^{:line 445 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapv ^{:line 445 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [p] ^{:line 446 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [objs ^{:line 446 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (get ^{:line 446 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:objs acc) p)
   derived-card ^{:line 447 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 447 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (multi-pred? ^{:line 447 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:sv acc) p) "multi" "single")
   derived-kind ^{:line 448 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (classify-kind objs)
   ov-card ^{:line 449 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (override-of tuples p "cardinality")
   ov-kind ^{:line 450 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (override-of tuples p "value_kind")]
  ^{:line 451 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (->Predicate p ^{:line 453 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 453 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ov-card) ov-card derived-card) ^{:line 454 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 454 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? ov-kind) ov-kind derived-kind) ^{:line 455 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (domain-sample tuples p) ^{:line 456 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (count objs)))) preds)))

^{:line 463 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^Boolean schema-field? [f]
  ^{:line 464 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (or ^{:line 464 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= f "cardinality") ^{:line 464 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= f "value_kind")))

^{:line 466 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn write-schema! [port pname field value]
  ^{:line 467 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 467 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 467 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? pname) ^{:line 467 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (and ^{:line 467 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (schema-field? field) ^{:line 467 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? value))) ^{:line 468 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [res ^{:line 468 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/coord-assert! port ^{:line 468 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (pred-node pname) ^{:line 468 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str "schema_" field) value)]
  ^{:line 469 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {:ok ^{:line 469 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (not ^{:line 469 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/rejected? res)) :res res :predicate pname :field field :value value}) ^{:line 470 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {:ok false :error "need {predicate, field∈{cardinality,value_kind}, value}"}))

^{:line 473 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn jport [params]
  ^{:line 474 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [p ^{:line 474 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:port params)]
  ^{:line 475 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 475 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? p) ^{:line 475 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [n ^{:line 475 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (parse-long p)]
  ^{:line 475 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 475 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? n) n 7978)) 7978)))

^{:line 477 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn body-port [b]
  ^{:line 478 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [p ^{:line 478 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:port b)]
  ^{:line 478 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 478 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? p) p 7978)))

^{:line 482 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn sport [m]
  ^{:line 483 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [p ^{:line 483 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:port m)]
  ^{:line 484 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (cond
  ^{:line 485 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (nil? p) 7977
  ^{:line 486 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (int? p) p
  :else ^{:line 487 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [n ^{:line 487 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (parse-long ^{:line 487 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str p))]
  ^{:line 487 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 487 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? n) n 7977)))))

^{:line 489 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn mins-of [params]
  ^{:line 490 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [m ^{:line 490 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:mins params)]
  ^{:line 491 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 491 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? m) ^{:line 491 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [n ^{:line 491 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (parse-long m)]
  ^{:line 491 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 491 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? n) n 30)) 30)))

^{:line 493 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn ^String agent-of [params]
  ^{:line 494 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [a ^{:line 494 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:agent params)]
  ^{:line 494 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 494 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? a) a "")))

^{:line 496 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn window-of [params]
  ^{:line 497 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [w ^{:line 497 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:window params)]
  ^{:line 498 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 498 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? w) ^{:line 498 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [n ^{:line 498 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (parse-long w)]
  ^{:line 498 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 498 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? n) n 200)) 200)))

^{:line 500 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn parse-graphs [params]
  ^{:line 501 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [g ^{:line 501 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:graphs params)]
  ^{:line 502 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (if ^{:line 502 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (some? g) ^{:line 502 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (mapv ^{:line 502 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (fn [x] ^{:line 502 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/trim x)) ^{:line 502 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str/split g #",")) nil)))

^{:line 504 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn json-resp [data]
  ^{:line 505 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {:status 200 :headers ^{:line 505 :file "/home/tom/code/framescope/bridge/bridge.bclj"} {"Content-Type" "application/json" "Access-Control-Allow-Origin" "*"} :body ^{:line 505 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/to-json data)})

^{:line 510 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn route! [req]
  ^{:line 511 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (let [uri ^{:line 511 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (str ^{:line 511 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:uri req))
   params ^{:line 512 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/qparams ^{:line 512 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:query-string req))
   post? ^{:line 513 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (= :post ^{:line 513 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (:request-method req))]
  ^{:line 514 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (case uri
    "/graph" (json-resp (if (some? (:port params)) (snapshot-or-empty (jport params)) (federated (parse-graphs params))))
    "/presence" (json-resp (presence (jport params)))
    "/timetape" (json-resp (timetape (jport params) (mins-of params)))
    "/schema" (if post? (let [b (rt/read-json-body req)]
  (json-resp (write-schema! (sport b) (:predicate b) (:field b) (:value b)))) (json-resp (schema-of (sport params))))
    "/live" (if (:websocket? req) (rt/ws-live req) {:status 400 :body "ws only"})
    "/stream" (if (:websocket? req) (rt/ws-stream req (:uuid params)) {:status 400 :body "ws only"})
    "/steer" (if post? (let [b (rt/read-json-body req)]
  (json-resp (rt/steer! (body-port b) (:to b) (:body b)))) {:status 405 :body "POST only"})
    "/distill" (if post? (json-resp {:decisions (distill! (agent-of params) (window-of params))}) {:status 405 :body "POST only"})
    "/node" (if post? (let [b (rt/read-json-body req)
   id (rt/gen-id (:kind b))]
  (rt/coord-assert! (body-port b) id "title" (let [tt (:title b)]
  (if (some? tt) tt "")))
  (json-resp {:ok true :id id})) {:status 405 :body "POST only"})
    "/edge" (if post? (let [b (rt/read-json-body req)
   res (rt/coord-assert! (body-port b) (:from b) (:pred b) (:to b))]
  (json-resp {:ok (not (rt/rejected? res)) :res res})) {:status 405 :body "POST only"})
    "/retract" (if post? (let [b (rt/read-json-body req)
   res (rt/coord-retract! (body-port b) (:from b) (:pred b) (:to b))]
  (json-resp {:ok (not (rt/rejected? res)) :res res})) {:status 405 :body "POST only"})
    (rt/serve-static uri))))

^{:line 558 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (defn handler [req]
  ^{:line 559 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/guard route! req))

^{:line 561 :file "/home/tom/code/framescope/bridge/bridge.bclj"} (rt/boot! handler)
