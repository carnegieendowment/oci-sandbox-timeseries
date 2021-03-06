/*global Oci, L */
'use strict';
require('mapbox.js');
var d3 = require('d3');
var $ = require('jquery');
import _ from 'lodash';
var turfCentroid = require('turf-centroid');

var utils = require('../utils');
var template = require('../templates/oildetails.ejs');
var ModelParameters = require('./modelparameters');
var BaseView = require('./baseview');
var OpgeeModel = require('../models/opgee');
var PrelimModel = require('../models/prelim');

var OilDetails = BaseView.extend({

  template: template,

  el: '.content',

  events: {
    'change #toggle-lpg': 'handleParametersChange',
    'change .config-dropdown': 'handleDropdown',
    'click #oil-details-share': 'handleShare',
    'click .carosel-arrow': 'handleCarosel',
    'click .compare': 'openCompare'
  },

  initialize: function (options) {
    var self = this;
    this.margin = {top: 0, right: 60, bottom: 0, left: 0};
    this.height = 75 - this.margin.top - this.margin.bottom;
    this.barBuffer = 2;
    this.hasShareLinkBeenParsed = false;

    // only used for sharing in this case
    this.chartElement = '#oil-details';
    // Find the oil key from the id
    for (var key in Oci.data.info) {
      if (utils.makeId(key) === options.oil) {
        this.oilKey = key;
        break;
      }
    }
    if (!this.oilKey) {
      console.warn('Unable to find key for oil id');
    }

    this.tip = d3.tip()
      .attr('class', 'd3-tip')
      .html(function (d, svg) {
        var unitsString = utils.getUnits('ghgTotal', 'perBarrel');
        var valuesString = '';
        var values = d.components[self.getStepName(svg)];
        for (var i = 0; i < values.length; i++) {
          valuesString += '<dt style="width:80%;">' + values[i].name + '</dt>';
          var value = Number(values[i].value);
          value = Math.abs(value) < 1 ? value.toFixed(1) : value.toFixed(0);
          valuesString += '<dd style="width:20%;">' + value + '</dd>';
        }
        return '<div class="popover in popover-compare">' +
          '<div class="popover-inner">' +
            '<div class="popover-header clearfix">' +
              '<dl class="stats-list">' +
                '<dt>' + self.getStepName(svg) + ' emissions<small class="units">' + unitsString + '</small></dt><dd>' + self.dataForSvg(svg, d).toFixed(0) + '</dd>' +
              '</dl>' +
            '</div>' +
            '<div class="popover-body">' +
              '<dl class="stats-list">' +
              valuesString +
              '</dl>' +
            '</div>' +
          '</div>' +
        '</div>';
      })
      // set tooltip offset and direction differently if they are "too small"
      .offset(function (d, svg) {
        if (self.dataForSvg(svg, d) < self.xScale.domain()[1] * 0.3) {
          return [0, 25];
        } else {
          return [-10, 0];
        }
      })
      .direction(function (d, svg) {
        if (self.dataForSvg(svg, d) < self.xScale.domain()[1] * 0.3) {
          return 'e';
        } else {
          return 'n';
        }
      });

    // Generate the oil info section
    this.oil = utils.generateOilInfo(this.oilKey);

    this.render();
  },

  render: function () {
    var self = this;
    this.$el.html(this.template({
      utils: utils,
      oil: this.oil,
      totalUnits: utils.getUnits('ghgTotal', 'perBarrel'),
      description: (Oci.blurbs[this.oilKey] || {}).description,
      icons: Oci.data.info[this.oilKey]['Absolute Emissions Icons'],
      suggestedOils: (Oci.relatedOils[this.oilKey] || []),
      relatedOils: (Oci.relatedOils[this.oilKey] && Oci.relatedOils[this.oilKey].map(function (oil) {
        var d = Oci.data.info[oil];
        if (d) {
          return utils.createTooltipHtml(
            d.Unique,
            d['Overall Crude Category'],
            [
              {
                name: 'GHG Emissions',
                value: utils.numberWithCommas(d['Total Emissions']),
                units: utils.getUnits('ghgTotal', 'perBarrel')
              },
              {
                name: 'Current Production',
                value: utils.numberWithCommas(d['Oil Production Volume']),
                units: utils.getUnits('productionVolume')
              },
              {
                name: 'Estimated GHG Emission Rate',
                value: utils.numberWithCommas(Number(d['Total Emissions']) * Number(d['Oil Production Volume']) * 365 / (1000 * 1000000)),
                units: utils.getUnits('emissionRate')
              }
            ],
            utils.makeId(d.Unique),
            '',
            d['Absolute Emissions Icons']
          );
        } else {
          return '';
        }
      }) || [])
    }));

    this.modelParametersView = new ModelParameters();
    this.$('#model-parameters').html(this.modelParametersView.render());
    this.listenTo(this.modelParametersView, 'sliderUpdate', this.handleParametersChange);

    // special handling of refinery dropdown for oil details view
    $('#dropdown-refinery').prop('selectedIndex',
      utils.refineryNameToDropdown(Oci.data.info[this.oilKey]['Default Refinery']));
    $('#dropdown-refinery option[value="0 = Default"]').hide();
    // remove any refinery options it doesn't have available
    Oci.data.metadata.refinery.split(', ').forEach(function (refinery, index) {
      if (Number(Oci.data.info[self.oil.Unique]['Refinery exception']) === index) {
        $('#dropdown-refinery option[value="' + refinery + '"]').hide();
      }
    });

    // Determine bar heights
    this.defaultModelHeight = (this.height - this.barBuffer) * (1 / 2);
    this.modelHeight = this.height - this.defaultModelHeight;

    // For responsiveness
    this.width = $('.container-charts').width() - this.margin.left - this.margin.right;

    L.mapbox.accessToken = 'pk.eyJ1IjoiZGV2c2VlZCIsImEiOiJnUi1mbkVvIn0.018aLhX0Mb0tdtaT2QNe2Q';

    var map = L.mapbox.map('map', 'mapbox.light', {
      zoomControl: false,
      keyboard: false,
      tap: false,
      dragging: false,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false
    });

    // add one oil
    var icon = L.divIcon({
      html: '',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      className: 'map-oil map-oil-main'
    });
    var oilfield = utils.getOilfield(this.oil.Unique);
    var centroid;
    if (oilfield) {
      centroid = turfCentroid(oilfield);
      L.marker([centroid.geometry.coordinates[1], centroid.geometry.coordinates[0]], {icon: icon, clickable: false}).addTo(map);
      // zoom to active
      map.setView([centroid.geometry.coordinates[1], centroid.geometry.coordinates[0]], 4);
    }

    this.chartInit();
    this._setupShare();
    this._activateSearchBar();
    this.activateCompareSearchBar();

    this._parseURLAndSetState();
    this.handleParametersChange();
    this.handleDropdown();
    this.hasShareLinkBeenParsed = true;
  },

  getStepName: function (svg) {
    return svg[0][0].parentNode.parentNode.id.split('-')[0];
  },

  updateSvg: function (svg) {
    var self = this;
    svg.selectAll('rect')
       .data(this.chartData)
       .transition()
       .duration(1000)
       .attr('width', function (d) {
         return self.xScale(self.dataForSvg(svg, d));
       });

    // Create small bars to indicate components
    var x0 = 0;
    var components = this.chartData[1].components[self.getStepName(svg)];
    svg.selectAll('.component')
       .data(components)
       .transition()
       .duration(1000)
       .attr('x', function (d) {
         x0 += +d.value;
         return self.xScale(x0);
       });

    // add text to show differences between the bars
    var diffData = {
      upstream: (this.chartData[1].upstream - this.chartData[0].upstream) / this.chartData[0].upstream,
      midstream: (this.chartData[1].midstream - this.chartData[0].midstream) / this.chartData[0].midstream,
      downstream: (this.chartData[1].downstream - this.chartData[0].downstream) / this.chartData[0].downstream
    };

    svg.selectAll('.diff-text')
        .data([diffData])
        .text(function (d) {
          var diff = self.dataForSvg(svg, d);
          return (diff > 0 ? '+' : '-') + Math.abs(diff * 100).toFixed(0) + '%';
        })
        .classed('invisible', function (d) {
          var diff = self.dataForSvg(svg, d);
          return Math.abs(diff) < 0.01;
        })
        .transition()
        .duration(1000)
        .attr('x', function (d) {
          return self.xScale(self.dataForSvg(svg, self.chartData[1])) + 12;
        });
  },

  createChartData: function () {
    // Default model data
    var defaultModelData = {
      info: Oci.data.info,
      opgee: Oci.Collections.opgee.get(utils.getOPGEEModel('0', '0', '0', '0')).toJSON(),
      prelim: Oci.Collections.prelim.get(utils.getPRELIMModel('0 = Default', 1)).toJSON()
    };

    // Grab things based on the model we're using
    var params = this.modelParametersView.getModelValues();

    // if we don't have the necessary data, load it
    var opgeeRun = utils.getOPGEEModel(params.solarSteam, params.water, params.flaring, params.year);
    var prelimRun = utils.getPRELIMModel(params.refinery, params.lpg);
    if (!Oci.Collections.opgee.get(opgeeRun)) {
      var opgeeModel = new OpgeeModel({ id: opgeeRun });
      opgeeModel.fetch({ async: false, success: function (data) {
        Oci.Collections.opgee.add(data);
      }});
    }

    if (!Oci.Collections.prelim.get(prelimRun)) {
      var prelimModel = new PrelimModel({ id: prelimRun });
      prelimModel.fetch({ async: false, success: function (data) {
        Oci.Collections.prelim.add(data);
      }});
    }

    var modelData = {
      info: Oci.data.info,
      opgee: Oci.Collections.opgee.get(opgeeRun).toJSON(),
      prelim: Oci.Collections.prelim.get(prelimRun).toJSON()
    };

    this.chartData = [
      utils.generateOilObject(this.oilKey, defaultModelData, true, true),
      utils.generateOilObject(this.oilKey, modelData, params.showCoke, false)
    ];
  },

  dataForSvg: function (svg, data) {
    if (svg === this.upstreamSvg) {
      return data.upstream;
    } else if (svg === this.downstreamSvg) {
      return data.downstream;
    } else if (svg === this.midstreamSvg) {
      return data.midstream;
    } else {
      console.warn('oops!');
    }
  },

  handleParametersChange: function () {
    this.createChartData();
    $('#model-total').html(this.chartData[1].ghgTotal.toFixed(0));
    // calculate total diff
    var totalDiff = (this.chartData[1].ghgTotal - this.chartData[0].ghgTotal) / this.chartData[0].ghgTotal;
    var totalDiffString = '(' + (totalDiff > 0 ? '+' : '-') +
      Math.abs(totalDiff * 100).toFixed(0) + '%)';
    $('#diff').html(totalDiffString);
    $('#diff').removeClass('invisible');
    if (Math.abs(totalDiff) < 0.01) {
      $('#diff').addClass('invisible');
    }
    this.updateSvg(this.upstreamSvg);
    this.updateSvg(this.downstreamSvg);
    this.updateSvg(this.midstreamSvg);
    this._updateCopyLink();
  },

  createScales: function () {
    var self = this;
    this.xScale = d3.scale.linear()
      .domain([0, d3.max(this.chartData,
        function (d) {
          return d3.max([utils.getGlobalExtent('perBarrel', 'max', 'downstream', self.oilKey),
                         utils.getGlobalExtent('perBarrel', 'max', 'midstream', self.oilKey),
                         utils.getGlobalExtent('perBarrel', 'max', 'upstream', self.oilKey)]);
        })])
        .range([0, self.width]);
  },

  createData: function (svg) {
    var self = this;
    // Set label
    $('#model-total').html(this.chartData[1].ghgTotal.toFixed(0));
    $('#default-total').html(this.chartData[0].ghgTotal.toFixed(0));

    // calculate total diff
    var totalDiff = (this.chartData[1].ghgTotal - this.chartData[0].ghgTotal) / this.chartData[0].ghgTotal;
    var totalDiffString = '(' + (totalDiff > 0.01 ? '+' : '') +
      (totalDiff < -0.01 ? '-' : '') +
      Math.abs(totalDiff * 100).toFixed(0) + '%)';
    $('#diff').html(totalDiffString);
    if (Math.abs(totalDiff) < 0.01) {
      $('#diff').addClass('invisible');
    }

    // Create bars
    svg.selectAll('rect')
       .data(this.chartData)
       .enter()
       .append('rect')
       .attr('x', function () { return self.xScale(0); })
       .attr('y', function (d) { return (d.isComparison) ? self.modelHeight + self.barBuffer : 0; })
       .attr('width', function (d) { return self.xScale(self.dataForSvg(svg, d)); })
       .attr('height', function (d) {
         return (d.isComparison) ? self.defaultModelHeight : self.modelHeight;
       })
       .attr('rx', 2)
       .attr('ry', 2)
       .attr('class', function (d) { return (d.isComparison) ? 'default' : 'main'; })
       .on('mouseover', function (d) { (!d.isComparison) ? self.tip.show(d, svg) : false; })
       .on('mouseout', function (d) {
         if (!d.isComparison) {
           if (utils.insideTooltip(d3.event.clientX, d3.event.clientY)) {
             $('.d3-tip').on('mouseleave', function () {
               self.tip.hide();
             });
           } else {
             self.tip.hide();
           }
         }
       });

    // Create small bars to indicate components if everything is positive
    var x0 = 0;
    var components = this.chartData[1].components[this.getStepName(svg)];
    var allPositive = _.every(components,
      function (component) {
        return +component.value >= 0;
      });
    if (allPositive) {
      svg.selectAll('.component')
         .data(components)
         .enter()
         .append('rect')
         .attr('class', 'component')
         .attr('pointer-events', 'none')
         .attr('x', function (d) {
           x0 += +d.value;
           return self.xScale(x0);
         })
         .attr('y', 0)
         .attr('width', self.xScale(0.25))
         .attr('height', self.modelHeight)
         .attr('rx', 2)
         .attr('ry', 2)
         .attr('fill', '#fff');
    }

    // add text to show differences between the bars
    var diffData = {
      upstream: (this.chartData[1].upstream - this.chartData[0].upstream) / this.chartData[0].upstream,
      midstream: (this.chartData[1].midstream - this.chartData[0].midstream) / this.chartData[0].midstream,
      downstream: (this.chartData[1].downstream - this.chartData[0].downstream) / this.chartData[0].downstream
    };

    svg.selectAll('.diff-text')
       .data([diffData])
       .enter()
       .append('text')
       .text(function (d) {
         var diff = self.dataForSvg(svg, d);
         return (diff > 0 ? '+' : '-') + Math.abs(diff * 100).toFixed(0) + '%';
       })
       .classed('invisible', function (d) {
         var diff = self.dataForSvg(svg, d);
         return Math.abs(diff) < 0.01;
       })
       .attr('x', function (d) {
         return self.xScale(self.dataForSvg(svg, self.chartData[1])) + 12;
       })
       .attr('y', self.modelHeight / 2 + 4)
       .attr('class', 'diff-text');
  },

  chartInit: function () {
    var width = this.width;
    var height = this.height;
    var margin = this.margin;

    // Create SVG element
    this.upstreamSvg = d3.select('#upstream-bar')
                .append('svg')
                .attr('width', width + margin.left + margin.right)
                .attr('height', height + margin.top + margin.bottom)
              .append('g')
                .attr('transform',
                      'translate(' + margin.left + ',' + margin.top + ')');

    this.downstreamSvg = d3.select('#downstream-bar')
                .append('svg')
                .attr('width', width + margin.left + margin.right)
                .attr('height', height + margin.top + margin.bottom)
              .append('g')
                .attr('transform',
                      'translate(' + margin.left + ',' + margin.top + ')');

    this.midstreamSvg = d3.select('#midstream-bar')
                .append('svg')
                .attr('width', width + margin.left + margin.right)
                .attr('height', height + margin.top + margin.bottom)
              .append('g')
                .attr('transform',
                      'translate(' + margin.left + ',' + margin.top + ')');

    // Invoke the tooltip
    this.upstreamSvg.call(this.tip);
    this.midstreamSvg.call(this.tip);
    this.downstreamSvg.call(this.tip);

    this.createChartData();
    this.createScales();
    this.createData(this.upstreamSvg);
    this.createData(this.midstreamSvg);
    this.createData(this.downstreamSvg);
  },

  handleDropdown: function () {
    $('.config-dropdown').blur();
    this.handleParametersChange();
  },
  // overwrite base _handleResize function
  _handleResize: function () {
    this.width = $('.container-charts').width() - this.margin.left - this.margin.right;
    // Clear anything in the svg element since we're going to rewrite
    d3.select('#upstream-bar').html('');
    d3.select('#midstream-bar').html('');
    d3.select('#downstream-bar').html('');
    this.chartInit();
  },

  handleShare: function (e) {
    e.preventDefault();
  },

  handleCarosel: function (e) {
    var increment = $(e.currentTarget).hasClass('forward') ? 1 : -1;
    var currentOffset;
    var $carosel = $(e.currentTarget).parent().find('.carosel');
    var $arrows = $('.carosel-arrow');

    [0, 1, 2, 3, 4].forEach(function (offset) {
      if ($carosel.hasClass('offset-' + offset)) {
        currentOffset = offset;
      }
    });
    $carosel.removeClass('offset-' + currentOffset);
    $arrows.removeClass('offset-' + currentOffset);
    $carosel.addClass('offset-' + (Number(currentOffset) + increment));
    $arrows.addClass('offset-' + (Number(currentOffset) + increment));
  },

  openCompare: function (e) {
    e.preventDefault();
    e.stopPropagation();
    var $targetDiv = $(e.currentTarget).parent().find('.dropdown-compare');
    $targetDiv.toggleClass('open');
    if ($targetDiv.hasClass('open')) {
      $targetDiv.find('input').focus();
    }
  },

  activateCompareSearchBar: function () {
    var self = this;
    var oilNames = [];
    _.forEach(Oci.data.info, function (oil) {
      oilNames.push(oil.Unique);
    });
    oilNames = oilNames.concat(Oci.regions, Oci.types);

    var CHARACTER_LIMIT = 1;
    $('.dropdown-compare input').on('input', function () {
      // Determine which oils match the partially-typed name
      var search = $(this).val();
      var re = new RegExp(search, 'i');
      var matchedNames = oilNames.filter(function (oilName) {
        return (
          search.length >= CHARACTER_LIMIT &&
          oilName.search(re) > -1
        );
      });

      // Create and insert the HTML
      var resultsHTML = matchedNames.map(function (oilName) {
        var oilID = utils.makeId(oilName);
        return '<div class="search-result"><a href="#compare/' + utils.makeId(self.oilKey) +
          '/' + oilID + '">' + oilName + '</a></div>';
      }).join('');
      $(this).parent().find('.search-results').html(resultsHTML);
    });

    // handle focus/blur on inputs
    // TODO: maybe check if this needs to be unbound
    $('.dropdown-compare input').focus(function (e) {
      $(e.currentTarget).parent().find('.search-results').addClass('visible');
    });

    $('.dropdown-compare input').blur(function (e) {
      setTimeout(function () {
        $(e.currentTarget).parent().find('.search-results').removeClass('visible');
      }, 200);
    });

    $('body').on('click.custom', function () {
      $('.dropdown-compare').removeClass('open');
    });

    $('.dropdown-compare').on('click.custom', function (e) {
      e.stopPropagation();
    });

    $('.dropdown-compare input').on('keyup', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var $container = $(this).parent().find('.search-results');
      var $results = $(this).parent().find('.search-result');
      var $previous, $next, $newActive;
      var oneActive = $results.hasClass('active');
      var $active = $results.parent().find('.active');

      if ($container.html()) {
        switch (e.keyCode) {
          case 38: // up
            if (oneActive) {
              $active.removeClass('active');
              $previous = $active.prev();
              // if a previous element exists, that becomes active, otherwise
              // go to the end
              // make sure our active result stays in view
              if ($previous.length) {
                $newActive = $previous.addClass('active');
                if ($newActive.position().top < 0) {
                  $container.scrollTop($container.scrollTop() - $newActive.outerHeight());
                }
              } else {
                $results.last().addClass('active');
                $container.scrollTop($container[0].scrollHeight);
              }
            } else {
              $results.last().addClass('active');
              $container.scrollTop($container[0].scrollHeight);
            }
            break;
          case 40: // down
            if (oneActive) {
              $active.removeClass('active');
              $next = $active.next();
              // if a next element exists, that becomes active, otherwise start
              // at the beginning
              // make sure our active result stays in view
              if ($next.length) {
                $newActive = $next.addClass('active');
                if ($newActive.position().top + $newActive.outerHeight() > $container.outerHeight()) {
                  $container.scrollTop($container.scrollTop() + $newActive.outerHeight());
                }
              } else {
                $results.first().addClass('active');
                $container.scrollTop(0);
              }
            } else {
              $results.first().addClass('active');
            }
            break;
          case 13: // enter/return
            if ($results.hasClass('active')) {
              Oci.router.navigate($active.find('a').attr('href'), {trigger: true});
            }
            break;
        }
      }
    });
  }
});

module.exports = OilDetails;
