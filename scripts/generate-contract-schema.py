"""Generate structural DTO JSON Schema. Runtime validators enforce semantic relationships."""
import re
import json
from pathlib import Path

source = Path('src/contracts/types.ts').read_text()
names = ['Versioned'] + re.findall(r'export interface (\w+)(?:<[^>]+>)? extends Versioned', source)
alias = {'SchemaVersion': {'const': 1}}
for name, value in re.findall(r'export type (\w+) = ([^;]+);', source):
    members = value.strip().split(' | ')
    if all(member.startswith("'") and member.endswith("'") for member in members):
        alias[name] = {'enum': [member[1:-1] for member in members]}

def split(value, separator):
    depth, quoted, start = 0, False, 0
    output = []
    for index, char in enumerate(value):
        if char == "'": quoted = not quoted
        if not quoted:
            if char in '<{[(': depth += 1
            elif char in '>}])': depth -= 1
            elif char == separator and depth == 0:
                output.append(value[start:index]); start = index + 1
    output.append(value[start:])
    return output

def shape(value):
    value = value.strip()
    parts = split(value, '|')
    if len(parts) > 1:
        if all(part.strip().startswith("'") for part in parts):
            return {'enum': [part.strip()[1:-1] for part in parts]}
        return {'anyOf': [shape(part) for part in parts]}
    if value.endswith('[]'): return {'type': 'array', 'items': shape(value[:-2])}
    if value in alias: return alias[value]
    if value in ['string', 'number', 'boolean', 'null']: return {'type': value}
    if value.startswith('Record<'): return {'type': 'object'}
    if value.startswith('UnknownValue<'):
        inner = shape(value[len('UnknownValue<'):-1])
        return {'allOf': [{'$ref': '#/$defs/UnknownValue'}, {'properties': {'value': {'anyOf': [inner, {'type': 'null'}]}}}]}
    if value.startswith("'"): return {'const': value[1:-1]}
    if value.startswith('{'): return properties(value[1:-1])
    if value in names: return {'$ref': '#/$defs/' + value}
    if value == 'MigrationLimits':
        return {'type': 'object', 'properties': {key: {'type': 'integer', 'minimum': 1, 'maximum': maximum} for key, maximum in [('max_bytes',268435456),('max_records',100000),('max_record_bytes',4194304),('max_duration_ms',90000)]}, 'additionalProperties': False}
    if value == 'CollectionBudget':
        return {'type': 'object', 'properties': {key: {'type': 'integer', 'minimum': 1} for key in ['max_duration_ms', 'max_bytes', 'max_directory_entries']}, 'required': ['max_duration_ms', 'max_bytes', 'max_directory_entries']}
    return {}

def properties(body, base=False):
    props = {'schema_version': {'const': 1}} if base else {}
    required = ['schema_version'] if base else []
    for field in split(body, ';'):
        match = re.match(r'\s*(\w+)(\?)?\s*:\s*(.*)', field, re.S)
        if not match: continue
        key, optional, value = match.groups()
        props[key] = shape(value)
        if not optional: required.append(key)
    return {'type': 'object', 'properties': props, 'required': required}

definitions = {}
for name in names:
    match = re.search(r'export interface ' + name + r'(?:<[^>]+>)?(?: extends Versioned)?\s*\{', source)
    start, depth = match.end(), 1
    index = start
    while depth:
        if source[index] == '{': depth += 1
        elif source[index] == '}': depth -= 1
        index += 1
    definitions[name] = properties(source[start:index-1], name != 'Versioned')
definitions['UnknownValue']['allOf'] = [{'if': {'properties': {'value': {'type': 'null'}}}, 'then': {'properties': {'reason': {'type': 'string', 'minLength': 1}}}, 'else': {'properties': {'reason': {'type': 'null'}}}}]
definitions['FactCandidate']['not'] = {'anyOf': [{'required': ['fact_id']}, {'required': ['revision']}, {'required': ['operation_id']}]}
definitions['WeeklyAnalysisResult']['properties']['proposed_confirmations']['maxItems'] = 3
definitions['WeeklyAnalysisInput']['properties']['previous_weeks']['maxItems'] = 4
root_types = ['SourceEvent', 'SourceCoverage', 'ReviewBundle', 'ReviewResult', 'FactRevision', 'JournalPatch', 'FactArtifact', 'PublishResult', 'BookkeepingConfig', 'Manifest', 'WeeklyAnalysisInput', 'WeeklyAnalysisResult', 'MonthlyReviewInput', 'MonthlyReviewResult', 'AnalyticsReviewEvent']
result = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': 'https://llm-bookkeeping.local/contracts-v1.schema.json', 'title': 'Bookkeeping version 1 records', 'description': 'Structural DTO schema. Runtime validators additionally enforce identities, temporal ranges, review evidence, coverage and finite budgets.', 'anyOf': [{'$ref': '#/$defs/' + name} for name in root_types], '$defs': definitions}
Path('schemas/contracts.schema.json').write_text(json.dumps(result, indent=2) + '\n')
