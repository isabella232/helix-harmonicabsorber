onic Absorber

[Report 1](./report_2020-10-26T23-09-31.731Z/)  
[Report 2](./report_2020-11-02T20-21-41.718Z/)  
[Report 3](./report_2020-11-02T22-26-11.212Z/)  
[Report 4](./report_00004_2020-11-02T20-21-41.718Z/)  
[Report 5](./report_00005_2020-11-02T22-26-11.212Z/)  
[Report 6](./report_00006_2020-11-02T20-21-41.718Z/)  
[Report 7](./report_00007_2020-12-11T15:55:29.892Z/)  
[Report 8](./report_00008_2021-01-22T20:58:29.167Z)  
[Report 9](./report_00009_2021-02-08T22-37-41.559Z)  
[Report 10](./report_00010_2021-02-09T10:42:16.031Z)  
[Report 11](./report_00011_2021-02-09T10:53:21.242Z)  
[Report 12](./report_00012_2021-02-09T11:01:39.952Z)  
[Report 13](./report_00013_2021-02-09T12-04-24.940Z)  
[Report 14](./report_00014_2021-02-09T15:56:05.503Z)  

# Next Steps

## High Impact/Difficulty

* Determine method for variable sample size (just stopping once we have a
  high confidence result seems flawed and might increase the amount of false positive results)
* Using linearly (or otherwise) weighted means instead of the hard cutoff we use now: This should reduce in smoother score progressions
* Account for nonlinearity in the mapping from raw measurement to scoring interval using log normal distribution
  - Assuming the two experiments we are comparing have a underlying score of $µ_1=0.8, µ_2=0.9$ for example
  - And the environment decreases the score of $µ_2$ to $off(µ_2)=0.85
  - Because the log normal distriution compresses score difference towards the ends of the interval, 
    the score of $µ_1$ should be decreased to $off(µ_2)<0.75$
  - Thus we will measure a *greater* effect than is really present: $|µ_2-µ_1| < |off(µ_2)-off(µ_1)|$
  - We should find a way to incorporate this effect into our calculations; e.g. by enlarging the confidence interval in some sensible way
  - What if $off(µ*)$ is a multiplier rather than a constant added to the raw value?
* Experimental validation: Run many this entire construction many times on different machines and see if the variance over many runs is sufficiently small

## Low Impact/Difficulty

* Model TolerantNumber using proper and comprehensive Interval arithmatic
* Provide our own scoring function for lighthouse scores which produce singularities: https://github.com/GoogleChrome/lighthouse/issues/11881, https://github.com/GoogleChrome/lighthouse/issues/11882, https://github.com/GoogleChrome/lighthouse/issues/11883
* Multidimensional outlier rejection
* Ad-hoc generation of a correlation matrix on large sample sizes further refining our confidence interval.
* Gather only artifacts; lighthouse analysis in report step
* Display different confidence levels in scoreEstimation using coloring
* Validate our sampling methods with monte carlo simulations
  - Validate that our method can actually estimate distribution parameters with a high accuracy. Paper: "Parameter estimations from gaussian measurements: When and how to use dither."

# Tech improvements

* Reporting needs a proper data model
* Omit unneded audits (e.g. Audit.SCORING_MODES.NOT_APPLICABLE)
* Series should be point (not sequence) oriented
* Series should be able to deal with intervals
* Remove unneeded dependencies
* Store all artifacts required for rerunning lighthouse
