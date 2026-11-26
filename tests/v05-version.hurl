GET {{service}}/version
HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.commit" == "{{revision}}"
