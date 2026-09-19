-- Shared metadata and reviewed decisions update all derived comparisons for
-- one package. Avoid scanning the entire permanent history for each package.
CREATE INDEX competitor_classifications_package_status
  ON competitor_classifications(package_name, status, run_id);
