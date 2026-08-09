# Blueprint component manifests

Add a JSON manifest to register an exact part without changing application code. A manifest must inherit a validated `baseType`; it cannot invent arbitrary pins or electrical behavior. Invalid files are quarantined and reported by `/api/components`.
