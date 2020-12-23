# Harmonic Absorber

[Report 1](./report_2020-10-26T23-09-31.731Z/)  
[Report 2](./report_2020-11-02T20-21-41.718Z/)  
[Report 3](./report_2020-11-02T22-26-11.212Z/)  
[Report 4](./report_00004_2020-11-02T20-21-41.718Z/)  
[Report 5](./report_00005_2020-11-02T22-26-11.212Z/)  
[Report 6](./report_00006_2020-11-02T20-21-41.718Z/)  
[Report 7](./report_00007_2020-12-11T15:55:29.892Z/)  

# Next Steps

0. Store all artifacts required for rerunning lighthouse
1. Validate pScore on new run providing a rounded score (should see lower outlandishness, lower variance?)
2. Perform estimations on raw distributions
3. Provide our own scoring function for lighthouse scores which produce singularities: https://github.com/GoogleChrome/lighthouse/issues/11881, https://github.com/GoogleChrome/lighthouse/issues/11882, https://github.com/GoogleChrome/lighthouse/issues/11883
4. Report average/medians of statistical indicators (e.g. outlandishness)
5. Numerically estimate distributions for N values
6. Mathematical error bar estimation

median/mean, p95/p90/p80, 1/2/5/10/20/50 samples
2, 5-0, 5-1, 5-2, 10-0, 10-1, 10-2, 20-0, 20-2, 20-4, 50-2, 50-5, 50-10

## Maybe

* Remove unneeded dependencies
* Revisit outlier classification
* Series should be point (not sequence) oriented
* Gather only artifacts; lighthouse analysis in report step
* Omit unneded autits (e.g. Audit.SCORING_MODES.NOT_APPLICABLE)
* Reporting needs a proper data model

Experiment
  ExperimentGroup
    byRun : 0..100 -> LighthouseRun
      name -> Number,
    byMeasurement : name -> MeasurmentSeries
      0..100 -> Number
    allMeasurments() [0..100, name, Measurment]


Measurment
  value: Number
  derivates:
    score
    pScore
