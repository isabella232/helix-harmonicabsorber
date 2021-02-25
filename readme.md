# Harmonic Absorber

Harmonicabsorber is a research project to reduce the variance of lighthouse scores, so they can be used for performance tuning more easily.
The motivation behind this is that one lighthouse data collection can be vastly (up to 10 lighthouse points) different from the next. This makes
it very hard to understand whether a change to the site or setup has actually improved the score.

Currently, the statistical methods used here are probably better than any other way of analyzing multiple lighthouse runs. Comparing the performance
of two sites and finding out which one has a higher score can be accomplished in 5 lighthouse runs (per site) or more. If more runs are required this is
indicated because harmonicabsorber generates a two sigma (95%) confidence interval. It is likely, that given enough samples, performance improvements
of below one lighthouse score point can be detected!

Harmonicabsorber can also be used to generate an estimate of the absolute lighthouse score of a website. Te methods used to generate this estimate
are a massive improvement on just otne lighthouse run AND on the method recommended by lighthouse. The results are still not calibrated (globally usable;
do not translate to other machines data could be collected on), but if you want an estimate of the score this is still by far the best way.

## Using harmonicabsorber

This repo mainly contains the code used to research the statistical and data collection methods; this is not meant for production usage.
However, if you wish to use something like this in production using the code from this repo is probably your best possible starting point
and as the code is relatively high quality it shouldn't be too much work to get running.

1. Clone the repository
2. Run npm install
3. Edit src/gather.js with your settings (e.g. your site urls…)
4. Run `node src/ gather` to gather the data
5. Run `node src report harmonicabsorber_… my_report_dir` to generate the report
6. Open the report's index.html with your web browser.

If you wish to use this productively it would probably be best to add a feature to define experimental setups (urls) on the command
line and to abort the data collection once all the following conditions are met:

1. At least five sample points have been collected
2. The three sigma confidence interval has been outside the zero line for the last 20% (or 5, whichever is more) of the collected samples.

## How does it work?

Normal lighthouse runs just analyze a website a single time; the result has a very high variance. Because of this variance the lighthouse
project recommends taking the median of five lighthouse runs. This result is much more stable than using just one lighthouse run, but this
method still has issues:

* It is unknown how high the remaining variance is
* Sometimes five lighthouse runs are just not enough
* The result generated here is absolute; the longer you wait/if you use a different machine the results will be less and less comparable
  making it hard to answer questions like "does this optimization improve my score".

Harmonicabsorber uses standard empirical methods and advanced statistical methods to improve on this; accelerate data collection and
reduce required sample sizes so wait times for results are as short as possible.

* Multiple lighthouse workers are used to make use of multicore setups
* We run lighthouse scoring on the setups being compared roughly at the same time to deal with fluctuations in performance; this is similar to control groups used in science
* We output a confidence interval instead of a discrete value; this avoids confusion about the precision of the result.
* We output a confidence interval of the difference between two scores instead of leaving that subtraction to the user.
  This is similar to p-values used in research. In fact, if the confidence interval does not include, this basically indicates a p-value of <5% as we
  are using a two-sigma/95% confidence interval. The same that is used in research.
* Confidence intervals can (and should be!) increased to higher values for good results.
* Instead of taking the median of the overall score, we estimate the score separately for each sub score, generating a confidence interval which is then combined with other confidence intervals.
  This is a fairly technical point, but it basically means that less information is discarded, especially when outliers on sub scores are independent of each other.
* We deal with outliers by using an m estimator on the huber loss function; like the median this is a robust statistic, but a more advanced one.
  Instead of just taking the middle value like the median or using all values like the mean, this method basically represents a compromise.
  More extreme data is discarded to avoid outliers skewing our results, data close to the is averaged, so a more precise result is generated.
  This is again, very technically but basically it means again that more information in the samples collected is used than with just the median.

## Research reports

[Report 1](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_2020-10-26T23-09-31.731Z/report.md) – First ever analysis; tentative evidence that main source of variance is browser  
[Report 2](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_2020-11-02T20-21-41.718Z/report.md) – Improvement of score and variance are highly correlated; confirmation of previous results  
[Report 3](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_2020-11-02T22-26-11.212Z/report.md) – Raw data from Rep 2; Another repeat without major new results  
[Report 4](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00004_2020-11-02T20-21-41.718Z/readme.md) – Raw data from Rep 2; First analysis of sub scores. Contrary to previous results, none of our steps to reduce variance really worked well.  
[Report 5](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00005_2020-11-02T22-26-11.212Z/readme.md) - Raw data from Rep 2; Additional data for report 4.  
[Report 6](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00006_2020-11-02T20-21-41.718Z/readme.md) - Raw data from Rep 2;
[Report 7](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00007_2020-12-11T15:55:29.892Z/readme.md) – Raw data from Rep 2; Estimation of raw measurments on sub scores; *then* conversion into scoring space; higher quality graphics.  
[Report 8](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00008_2021-01-22T20:58:29.167Z/readme.md) – Raw data from Rep 2; Estimation of a confidence interval  
[Report 9](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00009_2021-02-08T22-37-41.559Z/readme.md) – Fresh data (report 2 was months ago)!
Report 11 – Has been lost; in the great…ahem…deletion? Stuff. Dunno.  
[Report 12](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00012_2021-02-09T11:01:39.952Z/readme.md) – Raw data from rep 9; Pur validation of our new algorithm (moving the generation of a confidence interval to the very end of the pipeline; using a standard deviation until then)  
[Report 13](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00013_2021-02-09T12-04-24.940Z/readme.md) – New Data! Using randomized, concurrent data collection to make better use of differential effects of noise in the data.  
[Report 14](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00014_2021-02-09T15:56:05.503Z/readme.md) – Data of report 12 with score estimate at the three sigma confidence interval (99.8% confidence instead of 95%)
[Report 15](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00015_2021-02-09T16-11-33.973Z/readme.md) - Repeat data collection to make sure we are generating consistent results; compare to report 4.
[Report 16](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00016_2021-02-10T13-31-48.338Z/readme.md) - Repeat on data collected in report 12 on different machine
[Report 17](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00017_2021-02-10T15-08-03.406Z/readme.md) - Repeat of data collection on 12 with timing; first indication that a sample size of 20 might be sufficient for basic use cases.  
[Report 18](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00018_2021-02-10T15-25-16.877Z/readme.md) – Repeat data collection, again for rep 12; this time with a single thread.  
[Report 19](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00019_2021-02-10T18-14-37.922Z/readme.md) – Yet another repeat for 12; using one sigma confidence interval (standard deviation); now we just need 15 samples  
[Report 20](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00020_2021-02-19T21:17:38.612Z/readme.md) - Switching from trimmed mean to huber loss based m estimation for estimation of central tendency (average score); this is a great improvement. Performance on statistically dual sub scores (which pivot between two points is unfortunately atrocious)  
[Report 21](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00021_2021-02-20T09:16:39.615Z/readme.md) - Re-analysis with new methodology on data from rep 9  
[Report 22](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00022_2021-02-20T12:08:46.964Z/readme.md) - Raw data from rep 9; using m-estimation on both scale and center
[Report 24](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00023_2021-02-20T12:14:57.249Z/readme.md) - Analysis of data from rep 16 with three sigma confidence and new statistical methodology  
[Report 25](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00025_2021-02-22T21:38:55.199Z/readme.md) – Reanalysis of data from report 9  
[Report 26](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00026_2021-02-22T21:38:55.199Z/readme.md) – Like report 25 (raw data from rep 16) but with logarithmic X axis on score estimation plots. The data looks like we can now be confident enough to require just a 5 run minimum sample and rely on our statistical methods for indication when there are data points required.  
[Report 27](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00027_2021-02-24T12-40-31.850Z/readme.md) – First real usage of harmonicobserver.  
[Report 28](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00028_2021-02-24T12-49-42.674Z/readme.md) – Repeat collection for report 27.  
[Report 29](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00029_2021-02-24T13-36-40.390Z/readme.md) – Repeat collection for report 27 with caching enabled.  
[Report 30](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00030_2021-02-24T20-42-31.540Z/readme.md) – Repeat collection for report 27 without concurrency.
[Report 31](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00031_2021-02-24T23-18-18.084Z/readme.md) – Part of report 30
[Report 32](https://github.com/adobe-rnd/helix-harmonicabsorber-reports/tree/master/report_00032_2021-02-25T10-28-15.087Z/readme.md) – Part of report 30

# Next Steps

## High Impact/Difficulty

* Can we calculate the mean squared error instead of the mean absolute error in our l and m estimators. (Squaring the weight too should be sufficient for this to yield decent results?)
* Determine method for variable sample size (just stopping once we have a
  high confidence result seems flawed and might increase the amount of false positive results)
  - Idea: Just collect data until confidence interval crosses the zero line (null hypothesis excluded) at three sigma confidence interval;
    display at two sigma?
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

# Literature used

- https://www.itl.nist.gov/div898/software/dataplot/refman1/auxillar/trimmecl.htm
- https://link.springer.com/chapter/10.1007/978-1-4612-4380-9_35
- http://dx.doi.org/10.1080/01621459.1967.10482914
- https://www.jstor.org/stable/2958105
- https://www.jstor.org/stable/2958405
- http://dx.doi.org/10.1080/01621459.1974.10482962
- https://doi.org/10.1080/03610927708827533
- https://link.springer.com/content/pdf/10.1007/BF02481078.pdf
- https://projecteuclid.org/journals/annals-of-statistics/volume-15/issue-2/M-Estimation-for-Discrete-Data--Asymptotic-Distribution-Theory-and/10.1214/aos/1176350367.full
- http://www.ressources-actuarielles.net/EXT/ISFA/1226.nsf/769998e0a65ea348c1257052003eb94f/d3a13f9fb23c0e17c1257827004bd249/$FILE/thesis300dpi.pdf
- https://www.tandfonline.com/doi/abs/10.1080/01621459.1993.10476408
- http://www.jstor.org/stable/2684697?origin=JSTOR-pdf
- https://www.sciencedirect.com/science/article/pii/S0895717701001091
- https://onlinelibrary.wiley.com/doi/abs/10.1002/sim.972
- Wu, Pei-Chen. The central limit theorem and comparing means, trimmed means, one step m-estimators and modified one step m-estimators under non-normality. Diss. University of Southern California, 2002.
- https://www.researchgate.net/publication/228906268_An_introduction_to_robust_estimation_with_R_functions
- https://www.researchgate.net/profile/George_Dombi/publication/242111906_Using_Biweights_for_Handling_Outliers/links/54ad7a9e0cf2828b29fca367/Using-Biweights-for-Handling-Outliers.pdf
- http://citeseerx.ist.psu.edu/viewdoc/download?doi=10.1.1.70.8794&rep=rep1&type=pdf
- https://projecteuclid.org/journals/bernoulli/volume-14/issue-3/The-central-limit-theorem-under-random-truncation/10.3150/07-BEJ116.full
- 10.1080/10543400802369053
- 10.1002/sim.4102
- http://dx.doi.org/10.1016/j.ejca.2011.12.024
- 10.1137/110839680
- http://cnx.org/content/m45285/1.12/
- 10.1109/TSP.2015.2436359
- 10.1002/sim.6614
- ISBN: 978-0-12-804733-0
- https://arxiv.org/pdf/math/0411462v2
- https://ieeexplore.ieee.org/abstract/document/8712540/
- https://arxiv.org/abs/2002.10716
