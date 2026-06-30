#!/usr/bin/env bash
# realize-the-model.sh (v2) — CLI prepends @ to the subject id, so pass BARE ids
# (strip the leading @ that the log/livefile carries). Values pass as-is. Persons
# use `display_name` (`name` is a reserved engine/schema predicate).
set -uo pipefail
cd /home/tom/code/tern
LS="bin/tern"
DATA=/home/tom/code/tern-data/claims.log
T=$(mktemp -d); FAIL=0; N=0
# w <verb> <subject(@-or-bare)> <pred> <value...> — strips a leading @ from the subject only
w() { local verb="$1" s="${2#@}"; shift 2; local out
  out="$("$LS" "$verb" "$s" "$@" 2>&1)"
  if echo "$out" | grep -qiE 'committed via coordinator'; then N=$((N+1))
  else echo "  FAIL: $verb $s $* => $out" >&2; FAIL=1; fi; }
# livefile <outfile> <pred> [value] — writes live "subj<TAB>value" lines
livefile() {
  bb -e "(require '[clojure.edn :as edn])
  (def recs (with-open [r (clojure.java.io/reader \"$DATA\")] (mapv edn/read-string (line-seq r))))
  (def lo (reduce (fn [m rc] (assoc m [(:l rc)(:p rc)(:r rc)] (:op rc))) {} recs))
  (def live (->> lo (filter (fn [[k op]] (= op \"assert\"))) (map key)))
  (def want \"${3:-}\")
  (doseq [t live :when (and (= (second t) \"$2\") (or (= want \"\") (= (nth t 2) want)))]
    (println (str (first t) \"\t\" (nth t 2))))" > "$1"
}

echo '== 3a: 3 person display_name nodes (FIRST) =='
w tell @tom_passarelli display_name "Tom Passarelli"
w tell @claude-code    display_name "claude-code"
w tell @claude         display_name "claude"
if [ "$FAIL" -ne 0 ]; then echo '!! 3a failed — aborting before bulk ops' >&2; exit 1; fi

echo '== 3b: purge live fleet-junk driver cells (zzz/probe) =='
livefile "$T/driver" driver
grep -E '@(.*zzz|probe)' "$T/driver" > "$T/junk" || true
while IFS=$'\t' read -r s v; do [ -n "$s" ] && w untell "$s" driver "$v"; done < "$T/junk"
echo "   junk purged: $(wc -l < "$T/junk")"

echo '== 3c: drop created_by =='
livefile "$T/cb" created_by
while IFS=$'\t' read -r s v; do [ -n "$s" ] && w untell "$s" created_by "$v"; done < "$T/cb"
echo "   created_by lines: $(wc -l < "$T/cb")"

echo '== 3d: drop source=migrated =='
livefile "$T/sm" source migrated
while IFS=$'\t' read -r s v; do [ -n "$s" ] && w untell "$s" source migrated; done < "$T/sm"
echo "   source=migrated lines: $(wc -l < "$T/sm")"

echo '== 3e: drop owner=personal (keep msa) =='
livefile "$T/op" owner personal
while IFS=$'\t' read -r s v; do [ -n "$s" ] && w untell "$s" owner personal; done < "$T/op"
echo "   owner=personal lines: $(wc -l < "$T/op")"

echo '== 3f: drop coordination (value captured) =='
livefile "$T/co" coordination
cp "$T/co" /tmp/coordination-note.txt
while IFS=$'\t' read -r s v; do [ -n "$s" ] && w untell "$s" coordination "$v"; done < "$T/co"

echo '== 3g: retract stale drivers on terminal threads =='
bb -e "(require '[clojure.edn :as edn])
  (def recs (with-open [r (clojure.java.io/reader \"$DATA\")] (mapv edn/read-string (line-seq r))))
  (def lo (reduce (fn [m rc] (assoc m [(:l rc)(:p rc)(:r rc)] (:op rc))) {} recs))
  (def live (->> lo (filter (fn [[k op]] (= op \"assert\"))) (map key)))
  (def term (set (concat (map first (filter #(= (second %) \"outcome\") live)) (map first (filter #(= (second %) \"abandoned\") live)))))
  (doseq [t live :when (and (= (second t) \"driver\") (term (first t)))] (println (str (first t) \"\t\" (nth t 2))))" > "$T/sd"
while IFS=$'\t' read -r s v; do [ -n "$s" ] && w untell "$s" driver "$v"; done < "$T/sd"
echo "   stale drivers: $(wc -l < "$T/sd")"

echo '== 3h: retract dangling depends_on edges (target not titled) =='
bb -e "(require '[clojure.edn :as edn])
  (def recs (with-open [r (clojure.java.io/reader \"$DATA\")] (mapv edn/read-string (line-seq r))))
  (def lo (reduce (fn [m rc] (assoc m [(:l rc)(:p rc)(:r rc)] (:op rc))) {} recs))
  (def live (->> lo (filter (fn [[k op]] (= op \"assert\"))) (map key)))
  (def titled (set (map first (filter #(= (second %) \"title\") live))))
  (doseq [t live :when (and (= (second t) \"depends_on\") (not (titled (nth t 2))))] (println (str (first t) \"\t\" (nth t 2))))" > "$T/dd"
while IFS=$'\t' read -r s v; do [ -n "$s" ] && w untell "$s" depends_on "$v"; done < "$T/dd"
echo "   dangling depends_on: $(wc -l < "$T/dd")"

rm -rf "$T"
echo "== writes committed: $N | failures: $FAIL =="
[ "$FAIL" -eq 0 ] && echo "== MIGRATION COMPLETE ==" || { echo "!! had failures"; exit 1; }
