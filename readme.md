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
[Report 15](./report_00015_2021-02-09T16-11-33.973Z)  
[Report 16](./report_00016_2021-02-10T13-31-48.338Z)  
[Report 17](./report_00017_2021-02-10T15-08-03.406Z)  
[Report 18](./report_00018_2021-02-10T15-25-16.877Z)  
[Report 19](./report_00019_2021-02-10T18-14-37.922Z)  
[Report 20](./report_00020_2021-02-19T21:17:38.612Z)  
[Report 21](./report_00021_2021-02-20T09:16:39.615Z)  
[Report 22](./report_00022_2021-02-20T12:08:46.964Z)  
[Report 24](./report_00023_2021-02-20T12:14:57.249Z)  
[Report 25](./report_00025_2021-02-22T21:38:55.199Z)  
[Report 26](./report_00026_2021-02-22T21:38:55.199Z)  


# Next Steps

## High Impact/Difficulty

* Determine method for variable sample size (just stopping once we have a
  high confidence result seems flawed and might increase the amount of false positive results)
* Account for nonlinearity in the mapping from raw measurement to scoring interval using log normal distribution
  - Assuming the two experiments we are comparing have a underlying score of $µ_1=0.8, µ_2=0.9$ for example
  - And the environment decreases the score of $µ_2$ to $off(µ_2)=0.85
  - Because the log normal distriution compresses score difference towards the ends of the interval, 
    the score of $µ_1$ should be decreased to $off(µ_2)<0.75$
  - Thus we will measure a *greater* effect than is really present: $|µ_2-µ_1| < |off(µ_2)-off(µ_1)|$
  - We should find a way to incorporate this effect into our calculations; e.g. by enlarging the confidence interval in some sensible way
  - What if $off(µ*)$ is a multiplier rather than a constant added to the raw value?
  - Idea: Use a regression (linear?) on the correlation between the two measurements; predict what mean score difference
    the resulting formula would yield on raw values of a certain range (e.g. where r such that score(r) ∈ [0.1; 0.9];
    or r ∈ [r/a; r*a] or something). Alternatively, just take the mode of that curve?
    + Let $R$ be the set of possible raw values, let $r ∈ R$
    + Let $S ↔ [0; 1]$ be the set of possibles; $s ∈ S$
    + Let $score(r) : R → S$ be the function mapping a raw values to score values
    + Let $X, Y$ be the data points
    + Let $T, U$ be the result of a continuous interpolation on $X and X$
    + Let $d(r)$ be the result of a linear regression on $T - U$
    + Let $f(r) : R → S = score(d(r)) - score(r)$ (that is the predicted difference between the score from Y and X given a specific raw baseline value;
      and this is probably wrong because it does not really honor the fact that we are modeling both constant and linear effects; need to think
      about this again)
    + The value we are looking for, is the median of the function $f(r)$.
* Experimental validation: Run many this entire construction many times on different machines and see if the variance over many runs is sufficiently small

## Low Impact/Difficulty

* Perform literature study aiming at improving the way we derive confidence intervals for our m-estimation of center and scale;
  is there any literature providing info? Our current method is just taking the standard deviation produced by the regression
  and dividing that by the root of the number of samples. This is analogous to how we would do it with the mean; is this acceptable?
* Can we use bootstrapping or a similar numeric method to derive a confidence interval?
* Our current method of using m estimation to derive scale in addition to standard deviation is an ad-hoc construction. As is our use of an l-estimator as a starting point.
  These are probably al-right, but are there any treatments of such constructions in the literature? We probably should perform monte-carlo simulations to support our use of these.
* Our l and m estimators do not calculate mean squared errors, they calculate mean absolute distances on top of using the huber loss function as a weight. On top of
  deriving a standard deviation from mse is non-trivial because the correction factor is distribution dependant. This construction is not
  specifically supported by our currently available literature. We should probably at least use monte carlo simulations to derive a correction factor
  specific to our use. Maybe we can find a better way (e.g. bootstrapping) to derive a confidence interval, sidestepping this entire problem.
  Maybe we can derive some worst case estimate of the correction factor rigorously and use that?
* Model TolerantNumber using proper and comprehensive Interval arithmatic
* Provide our own scoring function for lighthouse scores which produce singularities: https://github.com/GoogleChrome/lighthouse/issues/11881, https://github.com/GoogleChrome/lighthouse/issues/11882, https://github.com/GoogleChrome/lighthouse/issues/11883
* Multidimensional outlier rejection
* Ad-hoc generation of a correlation matrix on large sample sizes further refining our confidence interval.
* Gather only artifacts; lighthouse analysis in report step
* Display different confidence levels in scoreEstimation using coloring
* Validate our sampling methods with monte carlo simulations
  - Validate that our method can actually estimate distribution parameters with a high accuracy. Paper: "Parameter estimations from gaussian measurements: When and how to use dither."
* Use calibration lighthouse runs as suggested in [report 16](./report_00016_2021-02-10T13-31-48.338Z).

# Tech improvements

* Reporting needs a proper data model
* Omit unneded audits (e.g. Audit.SCORING_MODES.NOT_APPLICABLE)
* Series should be point (not sequence) oriented
* Series should be able to deal with intervals
* Remove unneeded dependencies
* Store all artifacts required for rerunning lighthouse
* Efficiency improvements!
* Model statistical functions as functions; The caching layer should be optional
